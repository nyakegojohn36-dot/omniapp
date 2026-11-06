/**
 * Settlement tests: the boundary where money becomes stock.
 *
 * These run against the in-memory commerce adapter, which is held to the same
 * contract as the Firestore one, so the assertions are about the rules rather
 * than about a particular database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommerceState } from './commerceState.ts';
import { applyStkOutcome, handleStkCallback, type SettlementDeps } from './mpesaSettlement.ts';
import type { Order, WarehouseInventory } from './types.ts';

const TENANT = 'tenant-settlement';
const SKU = 'TSHIRT001';

function inventoryRow(): WarehouseInventory {
  return {
    sku: SKU,
    warehouseId: 'WH-MAIN',
    warehouseName: 'Main Hub',
    physicalStock: 5,
    reservedStock: 0,
    quarantineStock: 0,
    lowStockThreshold: 1,
    lastReconciledAt: new Date().toISOString(),
  };
}

function orderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ORD-000123',
    tenantId: TENANT,
    customerId: 'cust-1',
    customerName: 'Wanjiru Kamau',
    customerEmail: 'wanjiru@example.test',
    customerPhone: '254752720933',
    items: [
      {
        id: 'item-1',
        productId: 'prod-tshirt',
        sku: SKU,
        title: 'Merino Wool Trail Crewneck T-Shirt',
        quantity: 2,
        unitPriceCents: 240000,
        subtotalCents: 480000,
      },
    ],
    currency: 'KES',
    subtotalCents: 480000,
    taxCents: 0,
    shippingCents: 0,
    discountCents: 0,
    totalCents: 480000,
    status: 'AWAITING_PAYMENT',
    paymentMethod: 'MPESA_PAYBILL',
    isPaid: false,
    mpesaCheckoutRequestId: 'ws_CO_123',
    mpesaAmountKes: 4800,
    shippingAddress: {
      fullName: 'Wanjiru Kamau',
      addressLine1: 'Kimathi Street',
      city: 'Nairobi',
      postalCode: '00100',
      countryCode: 'KE',
      phone: '254752720933',
    },
    auditTrail: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function callbackBody(overrides: {
  checkoutRequestId?: string;
  amount?: number;
  receipt?: string;
  resultCode?: number;
  resultDesc?: string;
} = {}) {
  const resultCode = overrides.resultCode ?? 0;
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'merchant-1',
        CheckoutRequestID: overrides.checkoutRequestId ?? 'ws_CO_123',
        ResultCode: resultCode,
        ResultDesc: overrides.resultDesc ?? 'The service request is processed successfully.',
        ...(resultCode === 0
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: overrides.amount ?? 4800 },
                  { Name: 'MpesaReceiptNumber', Value: overrides.receipt ?? 'QKD73HD892' },
                  { Name: 'PhoneNumber', Value: 254752720933 },
                ],
              },
            }
          : {}),
      },
    },
  };
}

/** Wires the settlement deps around one reserved order. */
async function scenario(order: Order = orderFixture()) {
  const state = new InMemoryCommerceState({ tenantId: TENANT, inventory: [inventoryRow()] });
  const reserve = await state.reserve(TENANT, {
    orderId: order.id,
    sku: SKU,
    quantity: 2,
    ttlMinutes: 15,
  });
  assert.equal(reserve.success, true);

  const withReservation: Order = { ...order, reservationId: reserve.reservation?.id };
  const orders = new Map<string, Order>([[withReservation.mpesaCheckoutRequestId!, withReservation]]);
  const written: Order[] = [];

  const deps: SettlementDeps = {
    state,
    findOrderByCheckoutRequestId: async (checkoutRequestId) =>
      orders.get(checkoutRequestId) ?? null,
    saveOrder: async (saved) => {
      written.push(saved);
      if (saved.mpesaCheckoutRequestId) orders.set(saved.mpesaCheckoutRequestId, saved);
    },
  };

  return { state, deps, order: withReservation, written };
}

test('settlement: a Safaricom callback confirms the order and takes the stock', async () => {
  const { state, deps, order } = await scenario();
  const before = await state.getAvailability(TENANT, SKU);
  assert.equal(before.availableStock, 3);

  const result = await handleStkCallback(deps, callbackBody());

  assert.equal(result.status, 'SETTLED');
  if (result.status !== 'SETTLED') return;
  assert.equal(result.receipt, 'QKD73HD892');
  assert.equal(result.order.id, order.id);
  assert.equal(result.order.status, 'CONFIRMED');
  assert.equal(result.order.isPaid, true);
  assert.equal(result.order.mpesaReceiptCode, 'QKD73HD892');
  assert.equal(result.order.paymentTransactionRef, 'QKD73HD892');

  // Committed: physical stock dropped by the reserved quantity.
  const after = await state.getAvailability(TENANT, SKU);
  assert.equal(after.physicalStock, 3);
  assert.equal(after.reservedStock, 0);
  assert.equal(after.availableStock, 3);
});

test('settlement: a replayed callback changes nothing and never double-deducts', async () => {
  const { state, deps } = await scenario();

  const first = await handleStkCallback(deps, callbackBody());
  assert.equal(first.status, 'SETTLED');
  const afterFirst = await state.getAvailability(TENANT, SKU);

  const second = await handleStkCallback(deps, callbackBody());
  assert.equal(second.status, 'ALREADY_SETTLED');
  if (second.status === 'ALREADY_SETTLED') assert.equal(second.receipt, 'QKD73HD892');

  const afterSecond = await state.getAvailability(TENANT, SKU);
  assert.deepEqual(afterSecond, afterFirst);
});

test('settlement: an underpayment is escalated instead of confirming the order', async () => {
  const { state, deps } = await scenario();
  const before = await state.getAvailability(TENANT, SKU);

  const result = await handleStkCallback(deps, callbackBody({ amount: 100 }));

  assert.equal(result.status, 'AMOUNT_MISMATCH');
  if (result.status !== 'AMOUNT_MISMATCH') return;
  assert.equal(result.expectedKes, 4800);
  assert.equal(result.receivedKes, 100);
  assert.equal(result.order.isPaid, false);
  assert.equal(result.order.status, 'EXCEPTION_REVIEW');

  // Stock stays reserved: the units are neither sold nor released.
  const after = await state.getAvailability(TENANT, SKU);
  assert.deepEqual(after, before);
});

test('settlement: a declined prompt records the failure and keeps the reservation', async () => {
  const { state, deps } = await scenario();

  const result = await handleStkCallback(
    deps,
    callbackBody({ resultCode: 1032, resultDesc: 'Request cancelled by user' })
  );

  assert.equal(result.status, 'FAILED_RECORDED');
  if (result.status !== 'FAILED_RECORDED') return;
  assert.equal(result.resultCode, 1032);
  assert.equal(result.order.status, 'PAYMENT_FAILED');
  assert.equal(result.order.isPaid, false);

  // The customer can retry inside the TTL window, so the units stay held.
  const reservations = await state.listReservations(TENANT, { orderId: result.order.id });
  assert.equal(reservations[0].status, 'ACTIVE');
});

test('settlement: an unknown checkout request is reported, not guessed at', async () => {
  const { deps } = await scenario();
  const result = await handleStkCallback(deps, callbackBody({ checkoutRequestId: 'ws_CO_unissued' }));
  assert.equal(result.status, 'NOT_FOUND');
});

test('settlement: a malformed payload never settles anything', async () => {
  const { deps, written } = await scenario();
  const result = await handleStkCallback(deps, { Body: { stkCallback: { ResultCode: 0 } } });
  assert.equal(result.status, 'MALFORMED');
  assert.equal(written.length, 0);
});

test('settlement: a payment for a cancelled order is held for review, never confirmed', async () => {
  const { deps } = await scenario(
    orderFixture({ status: 'CANCELLED', mpesaCheckoutRequestId: 'ws_CO_123' })
  );

  const result = await applyStkOutcome(deps, {
    kind: 'PAID',
    checkoutRequestId: 'ws_CO_123',
    receipt: 'QKD73HD892',
    amountKes: 4800,
  });

  // CANCELLED is terminal, so CONFIRMED is refused: the money is real but a
  // callback cannot revive the order, so it is parked for a human.
  assert.equal(result.status, 'REQUIRES_REVIEW');
  if (result.status !== 'REQUIRES_REVIEW') return;
  assert.equal(result.order.isPaid, false);
  assert.equal(result.order.status, 'CANCELLED');
});
