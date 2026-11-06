/**
 * M-Pesa settlement: turning a Safaricom callback into an order state change.
 *
 * Invariants enforced here, because this is where money meets stock:
 *
 *  1. A settlement is only ever driven by a Safaricom callback (or an explicit
 *     reconciliation query), never by a customer claim.
 *  2. The amount collected must cover the exact amount that was requested. A
 *     short payment is recorded and escalated, never confirmed.
 *  3. Replays are harmless. Safaricom retries callbacks, so a second delivery of
 *     the same receipt returns ALREADY_SETTLED and changes nothing.
 *  4. Confirming commits the stock reservations, so the units actually leave the
 *     warehouse only once the money is real.
 */

import type { CommerceState } from './commerceState.ts';
import { amountKesFromCents, parseStkCallback, type StkCallbackOutcome } from './mpesaDaraja.ts';
import { transitionOrder } from './orderStateMachine.ts';
import type { Order } from './types.ts';

export interface SettlementDeps {
  state: CommerceState;
  findOrderByCheckoutRequestId(checkoutRequestId: string): Promise<Order | null>;
  saveOrder(order: Order): Promise<void>;
}

export type SettlementResult =
  | { status: 'SETTLED'; order: Order; receipt: string }
  | { status: 'ALREADY_SETTLED'; order: Order; receipt?: string }
  | { status: 'FAILED_RECORDED'; order: Order; resultCode: number; description: string }
  | { status: 'NOT_FOUND'; checkoutRequestId: string }
  | { status: 'AMOUNT_MISMATCH'; order: Order; expectedKes: number; receivedKes: number }
  | { status: 'REQUIRES_REVIEW'; order: Order; reason: string }
  | { status: 'MALFORMED'; reason: string };

async function commitReservations(state: CommerceState, order: Order): Promise<void> {
  const reservations = await state.listReservations(order.tenantId, { orderId: order.id });
  for (const reservation of reservations) {
    if (reservation.status !== 'ACTIVE') continue;
    await state.commit(order.tenantId, reservation.id);
  }
}

/** Applies a parsed callback outcome to the matching order. */
export async function applyStkOutcome(
  deps: SettlementDeps,
  outcome: StkCallbackOutcome
): Promise<SettlementResult> {
  if (outcome.kind === 'MALFORMED') {
    return { status: 'MALFORMED', reason: outcome.reason };
  }

  const order = await deps.findOrderByCheckoutRequestId(outcome.checkoutRequestId);
  if (!order) {
    return { status: 'NOT_FOUND', checkoutRequestId: outcome.checkoutRequestId };
  }

  if (outcome.kind === 'FAILED') {
    // The prompt was cancelled, timed out, or had no funds. No money moved, so
    // nothing is un-reserved: the customer may retry inside the TTL window.
    const transition = transitionOrder(order, 'PAYMENT_FAILED', {
      actor: 'M-PESA',
      actorRole: 'SYSTEM',
      reason: `M-Pesa declined the payment request (${outcome.resultCode}: ${outcome.resultDescription}).`,
      metadata: {
        checkoutRequestId: outcome.checkoutRequestId,
        resultCode: outcome.resultCode,
      },
    });
    const next = transition.success ? transition.order : order;
    if (transition.success) await deps.saveOrder(next);
    return {
      status: 'FAILED_RECORDED',
      order: next,
      resultCode: outcome.resultCode,
      description: outcome.resultDescription,
    };
  }

  // A paid order that is already marked paid is Safaricom retrying a callback.
  if (order.isPaid || order.status === 'CONFIRMED') {
    return { status: 'ALREADY_SETTLED', order, receipt: order.mpesaReceiptCode };
  }

  const expectedKes = order.mpesaAmountKes ?? amountKesFromCents(order.totalCents);
  if (outcome.amountKes < expectedKes) {
    // Underpayment must not confirm the order. Park it for a human.
    const escalated = transitionOrder(order, 'EXCEPTION_REVIEW', {
      actor: 'M-PESA',
      actorRole: 'SYSTEM',
      reason: `Collected KSh ${outcome.amountKes} against a requested KSh ${expectedKes}.`,
      metadata: { receipt: outcome.receipt, receivedKes: outcome.amountKes, expectedKes },
    });
    await deps.saveOrder(escalated.success ? escalated.order : order);
    return {
      status: 'AMOUNT_MISMATCH',
      order: escalated.success ? escalated.order : order,
      expectedKes,
      receivedKes: outcome.amountKes,
    };
  }

  const transition = transitionOrder(order, 'CONFIRMED', {
    actor: 'M-PESA',
    actorRole: 'SYSTEM',
    reason: `Payment receipted by Safaricom (${outcome.receipt}).`,
    paymentConfirmed: true,
    metadata: {
      receipt: outcome.receipt,
      amountKes: outcome.amountKes,
      checkoutRequestId: outcome.checkoutRequestId,
      transactionDate: outcome.transactionDate,
    },
  });

  if (!transition.success) {
    // Never fabricate a confirmation. Record why and let staff decide.
    const blocked = transitionOrder(order, 'EXCEPTION_REVIEW', {
      actor: 'M-PESA',
      actorRole: 'SYSTEM',
      reason: `Payment received but the order could not be confirmed: ${transition.error}`,
      metadata: { receipt: outcome.receipt, amountKes: outcome.amountKes },
    });
    const parked = blocked.success ? blocked.order : order;
    await deps.saveOrder(parked);
    return {
      status: 'REQUIRES_REVIEW',
      order: parked,
      reason: transition.error ?? 'The order cannot be confirmed from its current status.',
    };
  }

  const settled: Order = {
    ...transition.order,
    isPaid: true,
    mpesaReceiptCode: outcome.receipt,
    paymentTransactionRef: outcome.receipt,
    mpesaPhoneNumber: outcome.phoneNumber ?? order.mpesaPhoneNumber,
  };

  // Money first, then stock: the units leave the warehouse only after settlement.
  await commitReservations(deps.state, settled);
  await deps.saveOrder(settled);

  return { status: 'SETTLED', order: settled, receipt: outcome.receipt };
}

/** Entry point for the public callback route. */
export async function handleStkCallback(
  deps: SettlementDeps,
  body: unknown
): Promise<SettlementResult> {
  return applyStkOutcome(deps, parseStkCallback(body));
}

/**
 * Dev-only settlement used by the demo "pay now" button. It is deliberately
 * explicit - a receipt prefixed SIMULATED cannot be mistaken for a real one, and
 * the caller must opt in with MPESA_ALLOW_SIMULATED=true.
 */
export async function simulateSettlement(
  deps: SettlementDeps,
  order: Order,
  receipt: string = `SIMULATED-${order.id}`
): Promise<SettlementResult> {
  return applyStkOutcome(deps, {
    kind: 'PAID',
    checkoutRequestId: order.mpesaCheckoutRequestId ?? `SIM-${order.id}`,
    receipt,
    amountKes: order.mpesaAmountKes ?? amountKesFromCents(order.totalCents),
  });
}
