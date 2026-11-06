/**
 * Returns: two-stage receipt and inspection.
 *
 * The blueprint promised a two-stage return, and `RETURN_REQUESTED` /
 * `REFUND_PENDING` already existed as labels with nothing behind them. This is
 * the behaviour.
 *
 * The stock arithmetic is the whole point, and it reuses the same primitive as
 * every other adjustment (`physicalDelta` / `quarantineDelta`):
 *
 *   receive  : physical +q, quarantine +q   -> the units are back, but unsellable
 *   restock  :              quarantine -r   -> r units return to the shelf
 *   scrap    : physical -d, quarantine -d   -> d units are destroyed
 *
 * Goods therefore cannot re-enter availability simply because a customer says
 * they posted them back. They become sellable only after a human has looked at
 * them, which is the difference between a return and a refund fraud.
 */

import type { CommerceState } from './commerceState.ts';
import { transitionOrder } from './orderStateMachine.ts';
import type { Order, OrderStatus, UserRole } from './types.ts';

export type ReturnReason =
  | 'DAMAGED_IN_TRANSIT'
  | 'WRONG_ITEM'
  | 'NOT_AS_DESCRIBED'
  | 'FAULTY'
  | 'CHANGED_MIND';

export type ReturnStatus =
  | 'REQUESTED'
  | 'RECEIVED'
  | 'INSPECTED'
  | 'REJECTED'
  | 'CLOSED';

export interface ReturnLine {
  sku: string;
  warehouseId: string;
  quantity: number;
  /** Filled at inspection: units fit to sell again. */
  restockQuantity?: number;
  /** Filled at inspection: units destroyed. */
  damagedQuantity?: number;
}

export interface ReturnAuditEntry {
  at: string;
  actor: string;
  actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT';
  action: string;
  note?: string;
}

export interface ReturnRequest {
  id: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  lines: ReturnLine[];
  reason: ReturnReason;
  note?: string;
  status: ReturnStatus;
  refundCents: number;
  auditTrail: ReturnAuditEntry[];
  requestedAt: string;
  receivedAt?: string;
  inspectedAt?: string;
  closedAt?: string;
}

export interface ReturnFailure {
  ok: false;
  status: number;
  error: string;
}

export interface ReturnSuccess {
  ok: true;
  order: Order;
  returnRequest: ReturnRequest;
}

/** Only a delivered order can be returned; everything else is a cancellation. */
const RETURNABLE_STATUSES: OrderStatus[] = ['DELIVERED'];

const REASONS: ReturnReason[] = [
  'DAMAGED_IN_TRANSIT',
  'WRONG_ITEM',
  'NOT_AS_DESCRIBED',
  'FAULTY',
  'CHANGED_MIND',
];

function purchasedQuantity(order: Order, sku: string): number {
  return order.items
    .filter((item) => item.sku === sku)
    .reduce((total, item) => total + item.quantity, 0);
}

function unitPrice(order: Order, sku: string): number {
  const line = order.items.find((item) => item.sku === sku);
  return line?.unitPriceCents ?? 0;
}

/**
 * Stage 0: the customer asks. Stock is untouched - nothing has moved yet - but
 * the order moves to RETURN_REQUESTED so the warehouse queue sees it.
 */
export function createReturnRequest(
  input: {
    order: Order;
    lines: { sku: string; quantity: number; warehouseId?: string }[];
    reason: ReturnReason;
    note?: string;
    /** Fallback warehouse when one is not resolved per SKU. */
    warehouseId?: string;
    /** Where each SKU actually shipped from, so goods come back to that shelf. */
    warehouseBySku?: Record<string, string>;
    actor: string;
    actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT';
    /** Returns already recorded for this order, so totals cannot be exceeded. */
    existingReturns?: ReturnRequest[];
  },
  deps: { nextReturnId: () => string; now?: () => Date }
): ReturnSuccess | ReturnFailure {
  const { order } = input;

  if (order.status === 'RETURN_REQUESTED') {
    // One open case per order. Merging a second claim into it would make the
    // refund amount ambiguous, so the first one has to be closed out first.
    return {
      ok: false,
      status: 409,
      error: `Order ${order.id} already has an open return. Close it before raising another.`,
    };
  }
  if (!RETURNABLE_STATUSES.includes(order.status)) {
    return {
      ok: false,
      status: 409,
      error: `Order ${order.id} is ${order.status}; only a delivered order can be returned.`,
    };
  }
  if (!REASONS.includes(input.reason)) {
    return { ok: false, status: 400, error: `Unknown return reason "${input.reason}".` };
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, status: 400, error: 'At least one line must be returned.' };
  }

  // Already-returned quantities count against the purchase, so a customer cannot
  // return the same shirt three times on three claims. A rejected claim does not
  // count: those goods went back to the customer, so they may claim again.
  const alreadyReturned = new Map<string, number>();
  for (const existing of input.existingReturns ?? []) {
    if (existing.orderId !== order.id) continue;
    if (existing.status === 'REJECTED') continue;
    for (const line of existing.lines) {
      alreadyReturned.set(line.sku, (alreadyReturned.get(line.sku) ?? 0) + line.quantity);
    }
  }

  const lines: ReturnLine[] = [];
  const seen = new Set<string>();
  for (const requested of input.lines) {
    const sku = String(requested.sku || '').trim().toUpperCase();
    const quantity = Number(requested.quantity);
    if (!sku) return { ok: false, status: 400, error: 'Every return line needs a SKU.' };
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, status: 400, error: `Return quantity for ${sku} must be a positive whole number.` };
    }
    if (seen.has(sku)) {
      return { ok: false, status: 400, error: `${sku} appears twice in the same return.` };
    }
    seen.add(sku);

    const purchased = purchasedQuantity(order, sku);
    if (purchased === 0) {
      return { ok: false, status: 400, error: `${sku} is not part of order ${order.id}.` };
    }
    const remaining = purchased - (alreadyReturned.get(sku) ?? 0);
    if (quantity > remaining) {
      return {
        ok: false,
        status: 409,
        error: `Only ${remaining} unit(s) of ${sku} can still be returned.`,
      };
    }

    // Without a warehouse the receipt cannot be booked in, so refuse up front
    // rather than discovering it after the customer has posted the parcel.
    const warehouseId =
      requested.warehouseId || input.warehouseBySku?.[sku] || input.warehouseId;
    if (!warehouseId) {
      return {
        ok: false,
        status: 409,
        error: `No warehouse is holding ${sku}, so the return cannot be booked in.`,
      };
    }

    lines.push({ sku, warehouseId, quantity });
  }

  const now = deps.now ? deps.now() : new Date();
  const timestamp = now.toISOString();
  const refundCents = lines.reduce(
    (total, line) => total + unitPrice(order, line.sku) * line.quantity,
    0
  );

  const transition = transitionOrder(order, 'RETURN_REQUESTED', {
    actor: input.actor,
    actorRole: input.actorRole,
    reason: `Return requested (${input.reason}).`,
    metadata: { lines, reason: input.reason },
  });
  if (!transition.success) {
    return { ok: false, status: 409, error: transition.error ?? 'The order cannot be returned.' };
  }

  return {
    ok: true,
    order: transition.order,
    returnRequest: {
      id: deps.nextReturnId(),
      tenantId: order.tenantId,
      orderId: order.id,
      customerId: order.customerId,
      lines,
      reason: input.reason,
      note: input.note,
      status: 'REQUESTED',
      refundCents,
      auditTrail: [
        {
          at: timestamp,
          actor: input.actor,
          actorRole: input.actorRole,
          action: 'REQUESTED',
          note: input.note,
        },
      ],
      requestedAt: timestamp,
    },
  };
}

/**
 * Stage 1: the goods physically arrive. They are booked into quarantine, so they
 * are counted but remain unsellable until inspection.
 */
export async function receiveReturn(
  returnRequest: ReturnRequest,
  order: Order,
  deps: {
    state: CommerceState;
    actor: string;
    actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT';
    warehouseId: string;
    now?: () => Date;
  }
): Promise<ReturnSuccess | ReturnFailure> {
  if (returnRequest.status !== 'REQUESTED') {
    return {
      ok: false,
      status: 409,
      error: `Return ${returnRequest.id} is ${returnRequest.status}; it cannot be received again.`,
    };
  }

  for (const line of returnRequest.lines) {
    const updated = await deps.state.adjust(returnRequest.tenantId, {
      sku: line.sku,
      warehouseId: line.warehouseId || deps.warehouseId,
      physicalDelta: line.quantity,
      quarantineDelta: line.quantity,
      reason: `Return ${returnRequest.id} received for order ${returnRequest.orderId}.`,
      actor: deps.actor,
    });
    if (!updated) {
      return {
        ok: false,
        status: 404,
        error: `No inventory record for ${line.sku} in ${line.warehouseId || deps.warehouseId}.`,
      };
    }
  }

  const timestamp = (deps.now ? deps.now() : new Date()).toISOString();
  return {
    ok: true,
    order,
    returnRequest: {
      ...returnRequest,
      status: 'RECEIVED',
      receivedAt: timestamp,
      auditTrail: [
        ...returnRequest.auditTrail,
        {
          at: timestamp,
          actor: deps.actor,
          actorRole: deps.actorRole,
          action: 'RECEIVED',
          note: 'Goods booked into quarantine pending inspection.',
        },
      ],
    },
  };
}

/**
 * Stage 2: inspection grades the goods.
 *
 *   APPROVED -> sellable units return to the shelf, damaged units are scrapped,
 *               and the order moves to REFUND_PENDING.
 *   REJECTED -> nothing is restocked and the order goes back to DELIVERED.
 */
export async function inspectReturn(
  returnRequest: ReturnRequest,
  order: Order,
  input: {
    decision: 'APPROVE' | 'REJECT';
    /** Units fit to sell again, per SKU. Defaults to all of them. */
    restock?: Record<string, number>;
    note?: string;
  },
  deps: {
    state: CommerceState;
    actor: string;
    actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT';
    now?: () => Date;
  }
): Promise<ReturnSuccess | ReturnFailure> {
  if (returnRequest.status !== 'RECEIVED') {
    return {
      ok: false,
      status: 409,
      error: `Return ${returnRequest.id} is ${returnRequest.status}; it must be received before inspection.`,
    };
  }

  const timestamp = (deps.now ? deps.now() : new Date()).toISOString();

  if (input.decision === 'REJECT') {
    // The goods are not ours to sell and not ours to keep: they go back to the
    // customer. That has to reverse the receipt, otherwise every rejected return
    // would strand its units in quarantine for good and the warehouse count would
    // drift away from what is on the shelf.
    for (const line of returnRequest.lines) {
      const updated = await deps.state.adjust(returnRequest.tenantId, {
        sku: line.sku,
        warehouseId: line.warehouseId,
        physicalDelta: -line.quantity,
        quarantineDelta: -line.quantity,
        reason: `Return ${returnRequest.id} rejected at inspection; ${line.quantity} unit(s) returned to the customer.`,
        actor: deps.actor,
      });
      if (!updated) {
        return {
          ok: false,
          status: 404,
          error: `No inventory record for ${line.sku} in ${line.warehouseId}.`,
        };
      }
    }

    const transition = transitionOrder(order, 'DELIVERED', {
      actor: deps.actor,
      actorRole: deps.actorRole,
      reason: `Return ${returnRequest.id} rejected at inspection${input.note ? `: ${input.note}` : '.'}`,
      metadata: { returnId: returnRequest.id },
    });
    return {
      ok: true,
      order: transition.success ? transition.order : order,
      returnRequest: {
        ...returnRequest,
        status: 'REJECTED',
        inspectedAt: timestamp,
        auditTrail: [
          ...returnRequest.auditTrail,
          {
            at: timestamp,
            actor: deps.actor,
            actorRole: deps.actorRole,
            action: 'REJECTED',
            note: input.note,
          },
        ],
      },
    };
  }

  // Grade every line before touching stock, so a bad payload changes nothing.
  const graded = returnRequest.lines.map((line) => {
    const requested = input.restock?.[line.sku];
    const restockQuantity = requested === undefined ? line.quantity : Number(requested);
    if (
      !Number.isInteger(restockQuantity) ||
      restockQuantity < 0 ||
      restockQuantity > line.quantity
    ) {
      return null;
    }
    return {
      ...line,
      restockQuantity,
      damagedQuantity: line.quantity - restockQuantity,
    };
  });

  if (graded.some((line) => line === null)) {
    return {
      ok: false,
      status: 400,
      error: 'Restock quantities must be whole numbers no greater than the returned quantity.',
    };
  }
  const lines = graded as ReturnLine[];

  for (const line of lines) {
    const warehouseId = line.warehouseId;
    if ((line.restockQuantity ?? 0) > 0) {
      // Out of quarantine and back on the shelf.
      const restocked = await deps.state.adjust(returnRequest.tenantId, {
        sku: line.sku,
        warehouseId,
        physicalDelta: 0,
        quarantineDelta: -(line.restockQuantity ?? 0),
        reason: `Return ${returnRequest.id} passed inspection; ${line.restockQuantity} unit(s) restocked.`,
        actor: deps.actor,
      });
      if (!restocked) {
        return {
          ok: false,
          status: 404,
          error: `No inventory record for ${line.sku} in ${warehouseId}.`,
        };
      }
    }
    if ((line.damagedQuantity ?? 0) > 0) {
      // Destroyed: leaves physical and quarantine together.
      const scrapped = await deps.state.adjust(returnRequest.tenantId, {
        sku: line.sku,
        warehouseId,
        physicalDelta: -(line.damagedQuantity ?? 0),
        quarantineDelta: -(line.damagedQuantity ?? 0),
        reason: `Return ${returnRequest.id} failed inspection; ${line.damagedQuantity} unit(s) written off.`,
        actor: deps.actor,
      });
      if (!scrapped) {
        return {
          ok: false,
          status: 404,
          error: `No inventory record for ${line.sku} in ${warehouseId}.`,
        };
      }
    }
  }

  // The state machine requires physical receipt before RETURNED, which is exactly
  // what this function establishes.
  const returned = transitionOrder(order, 'RETURNED', {
    actor: deps.actor,
    actorRole: deps.actorRole,
    reason: `Return ${returnRequest.id} inspected and accepted.`,
    itemReceivedAtWarehouse: true,
    metadata: { returnId: returnRequest.id, lines },
  });
  const refundPending = returned.success
    ? transitionOrder(returned.order, 'REFUND_PENDING', {
        actor: deps.actor,
        actorRole: deps.actorRole,
        reason: `Refund of ${returnRequest.refundCents} cents queued.`,
        metadata: { returnId: returnRequest.id, refundCents: returnRequest.refundCents },
      })
    : returned;

  return {
    ok: true,
    order: refundPending.success ? refundPending.order : order,
    returnRequest: {
      ...returnRequest,
      status: 'INSPECTED',
      lines,
      inspectedAt: timestamp,
      auditTrail: [
        ...returnRequest.auditTrail,
        {
          at: timestamp,
          actor: deps.actor,
          actorRole: deps.actorRole,
          action: 'INSPECTED',
          note: input.note,
        },
      ],
    },
  };
}

/**
 * Records that the money actually went back. Kept separate from inspection so a
 * finance delay cannot silently mark a refund as paid.
 */
export function markRefundPaid(
  returnRequest: ReturnRequest,
  order: Order,
  input: { actor: string; actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT'; refundReference: string },
  deps: { now?: () => Date }
): ReturnSuccess | ReturnFailure {
  if (returnRequest.status !== 'INSPECTED') {
    return {
      ok: false,
      status: 409,
      error: `Return ${returnRequest.id} is ${returnRequest.status}; only an inspected return can be refunded.`,
    };
  }
  if (!input.refundReference.trim()) {
    return { ok: false, status: 400, error: 'A refund reference is required.' };
  }

  const transition = transitionOrder(order, 'REFUNDED', {
    actor: input.actor,
    actorRole: input.actorRole,
    reason: `Refund paid against reference ${input.refundReference}.`,
    metadata: { returnId: returnRequest.id, refundReference: input.refundReference },
  });
  if (!transition.success) {
    return { ok: false, status: 409, error: transition.error ?? 'The refund cannot be recorded.' };
  }

  const timestamp = (deps.now ? deps.now() : new Date()).toISOString();
  return {
    ok: true,
    order: transition.order,
    returnRequest: {
      ...returnRequest,
      status: 'CLOSED',
      closedAt: timestamp,
      auditTrail: [
        ...returnRequest.auditTrail,
        {
          at: timestamp,
          actor: input.actor,
          actorRole: input.actorRole,
          action: 'REFUND_PAID',
          note: input.refundReference,
        },
      ],
    },
  };
}
