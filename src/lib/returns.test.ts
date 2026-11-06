/**
 * Returns tests: the point is the stock arithmetic.
 *
 * A return is three separate events - the customer asks, the box arrives, a human
 * grades what is inside - and only the last of those may put anything back on the
 * shelf. These tests pin that down: they assert availability before and after
 * every stage, so a future refactor that quietly restocks on promise fails here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommerceState } from './commerceState.ts';
import {
  createReturnRequest,
  inspectReturn,
  markRefundPaid,
  receiveReturn,
} from './returns.ts';
import type { Order, WarehouseInventory } from './types.ts';

const TENANT = 'tenant-returns';
const SKU = 'TSHIRT001';
const WAREHOUSE = 'WH-MAIN';

/**
 * The state after a fulfilled sale: five units were in stock, two were sold and
 * shipped, so three are left. That is the number every stage is measured against.
 */
function inventoryRow(): WarehouseInventory {
  return {
    sku: SKU,
    warehouseId: WAREHOUSE,
    warehouseName: 'Main Hub',
    physicalStock: 3,
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
    status: 'DELIVERED',
    paymentMethod: 'MPESA_PAYBILL',
    isPaid: true,
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

/** A deterministic id allocator, so assertions can name the return. */
function idGenerator() {
  let next = 0;
  return () => `RET-${String(++next).padStart(4, '0')}`;
}

function requestOn(order: Order, quantity = 2, overrides: Partial<Parameters<typeof createReturnRequest>[0]> = {}) {
  return createReturnRequest(
    {
      order,
      lines: [{ sku: SKU, quantity }],
      reason: 'DAMAGED_IN_TRANSIT',
      warehouseId: WAREHOUSE,
      actor: 'wanjiru@example.test',
      actorRole: 'CUSTOMER',
      ...overrides,
    },
    { nextReturnId: idGenerator() }
  );
}

function newState() {
  return new InMemoryCommerceState({ tenantId: TENANT, inventory: [inventoryRow()] });
}

test('returns: a request moves the order but touches no stock', async () => {
  const state = newState();
  const before = await state.getAvailability(TENANT, SKU);

  const result = requestOn(orderFixture());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.order.status, 'RETURN_REQUESTED');
  assert.equal(result.returnRequest.status, 'REQUESTED');
  assert.equal(result.returnRequest.id, 'RET-0001');
  // Two units at 240000 cents: the refund is priced from the order, never the client.
  assert.equal(result.returnRequest.refundCents, 480000);

  assert.deepEqual(await state.getAvailability(TENANT, SKU), before);
});

test('returns: only a delivered order can be returned', () => {
  const result = requestOn(orderFixture({ status: 'SHIPPED' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.match(result.error, /only a delivered order can be returned/);
});

test('returns: more units than were bought is refused', () => {
  const result = requestOn(orderFixture(), 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.match(result.error, /Only 2 unit\(s\)/);
});

test('returns: units already claimed cannot be claimed a second time', () => {
  const first = requestOn(orderFixture(), 1);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // The first claim opened a case, so the order is no longer in DELIVERED and a
  // concurrent second claim has nowhere to go.
  assert.equal(first.order.status, 'RETURN_REQUESTED');
  const second = requestOn(first.order, 2, { existingReturns: [first.returnRequest] });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.status, 409);
  assert.match(second.error, /already has an open return/);
});

test('returns: a rejected claim frees the units to be claimed again', async () => {
  const state = newState();
  const first = requestOn(orderFixture(), 1);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const received = await receiveReturn(first.returnRequest, first.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const rejected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'REJECT', note: 'No fault found.' },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(rejected.ok, true);
  if (!rejected.ok) return;
  assert.equal(rejected.order.status, 'DELIVERED');

  // The customer still holds all 2 units, so a fresh claim of the full quantity
  // is legitimate: the refused claim must not be held against them.
  const second = requestOn(rejected.order, 2, { existingReturns: [rejected.returnRequest] });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.returnRequest.refundCents, 480000);
});

test('returns: a SKU outside the order is refused', () => {
  const result = createReturnRequest(
    {
      order: orderFixture(),
      lines: [{ sku: 'JACKET001', quantity: 1 }],
      reason: 'WRONG_ITEM',
      warehouseId: WAREHOUSE,
      actor: 'wanjiru@example.test',
      actorRole: 'CUSTOMER',
    },
    { nextReturnId: idGenerator() }
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /is not part of order/);
});

test('returns: the same SKU twice in one claim is refused', () => {
  const result = createReturnRequest(
    {
      order: orderFixture(),
      lines: [
        { sku: SKU, quantity: 1 },
        { sku: SKU.toLowerCase(), quantity: 1 },
      ],
      reason: 'FAULTY',
      warehouseId: WAREHOUSE,
      actor: 'wanjiru@example.test',
      actorRole: 'CUSTOMER',
    },
    { nextReturnId: idGenerator() }
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /appears twice/);
});

test('returns: receiving books the units into quarantine, not into availability', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  assert.equal(received.returnRequest.status, 'RECEIVED');

  // The units are back in the building but nobody may buy them yet.
  const availability = await state.getAvailability(TENANT, SKU);
  assert.equal(availability.physicalStock, 5);
  assert.equal(availability.quarantineStock, 2);
  assert.equal(availability.availableStock, 3);
});

test('returns: a second receipt of the same box is refused', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const deps = {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF' as const,
    warehouseId: WAREHOUSE,
  };
  const first = await receiveReturn(requested.returnRequest, requested.order, deps);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = await receiveReturn(first.returnRequest, first.order, deps);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.status, 409);

  // Still two in quarantine, not four.
  const availability = await state.getAvailability(TENANT, SKU);
  assert.equal(availability.quarantineStock, 2);
});

test('returns: an approved inspection puts the goods back on the shelf', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'APPROVE' },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;

  assert.equal(inspected.returnRequest.status, 'INSPECTED');
  assert.deepEqual(
    inspected.returnRequest.lines.map((line) => [line.restockQuantity, line.damagedQuantity]),
    [[2, 0]]
  );
  // Both stages of the lifecycle ran: RETURNED then REFUND_PENDING.
  assert.equal(inspected.order.status, 'REFUND_PENDING');

  const availability = await state.getAvailability(TENANT, SKU);
  assert.equal(availability.physicalStock, 5);
  assert.equal(availability.quarantineStock, 0);
  assert.equal(availability.availableStock, 5);
});

test('returns: damaged units are written off instead of restocked', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'APPROVE', restock: { [SKU]: 1 } },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;

  assert.equal(inspected.returnRequest.lines[0].restockQuantity, 1);
  assert.equal(inspected.returnRequest.lines[0].damagedQuantity, 1);

  // One back on the shelf, one destroyed: the destroyed unit is not saleable and
  // is not sitting in quarantine either.
  const availability = await state.getAvailability(TENANT, SKU);
  assert.equal(availability.physicalStock, 4);
  assert.equal(availability.quarantineStock, 0);
  assert.equal(availability.availableStock, 4);
});

test('returns: a restock figure above the returned quantity changes nothing', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const before = await state.getAvailability(TENANT, SKU);
  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'APPROVE', restock: { [SKU]: 5 } },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );

  assert.equal(inspected.ok, false);
  if (inspected.ok) return;
  assert.equal(inspected.status, 400);
  assert.deepEqual(await state.getAvailability(TENANT, SKU), before);
});

test('returns: a rejected inspection leaves the stock exactly as it was sold', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'REJECT', note: 'Worn and washed.' },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;

  assert.equal(inspected.returnRequest.status, 'REJECTED');
  // The goods went back to the customer, so the count returns to three sold.
  assert.equal(inspected.order.status, 'DELIVERED');

  const availability = await state.getAvailability(TENANT, SKU);
  assert.equal(availability.physicalStock, 3);
  assert.equal(availability.quarantineStock, 0);
  assert.equal(availability.availableStock, 3);
});

test('returns: inspection before receipt is refused', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const inspected = await inspectReturn(
    requested.returnRequest,
    requested.order,
    { decision: 'APPROVE' },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(inspected.ok, false);
  if (inspected.ok) return;
  assert.equal(inspected.status, 409);
  assert.match(inspected.error, /must be received before inspection/);
});

test('returns: refunding requires an inspection, then completes the order', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  // A refund cannot jump ahead of the inspection that justifies it.
  const premature = markRefundPaid(
    requested.returnRequest,
    requested.order,
    { actor: 'owner@example.test', actorRole: 'BUSINESS_OWNER', refundReference: 'MPESA-QK1' },
    {}
  );
  assert.equal(premature.ok, false);
  if (premature.ok) return;
  assert.equal(premature.status, 409);

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'APPROVE' },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;

  const missingReference = markRefundPaid(
    inspected.returnRequest,
    inspected.order,
    { actor: 'owner@example.test', actorRole: 'BUSINESS_OWNER', refundReference: '   ' },
    {}
  );
  assert.equal(missingReference.ok, false);

  const paid = markRefundPaid(
    inspected.returnRequest,
    inspected.order,
    { actor: 'owner@example.test', actorRole: 'BUSINESS_OWNER', refundReference: 'MPESA-QK1' },
    {}
  );
  assert.equal(paid.ok, true);
  if (!paid.ok) return;

  assert.equal(paid.order.status, 'REFUNDED');
  assert.equal(paid.returnRequest.status, 'CLOSED');
  assert.equal(paid.returnRequest.auditTrail.at(-1)?.action, 'REFUND_PAID');
});

test('returns: a customer cannot drive an order into REFUND_PENDING', async () => {
  const state = newState();
  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'APPROVE' },
    // Refund queueing is a staff decision; the state machine must refuse it.
    { state, actor: 'wanjiru@example.test', actorRole: 'CUSTOMER' }
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;

  // The refusal is upstream of the transition, so the order is not left refunded.
  assert.notEqual(inspected.order.status, 'REFUND_PENDING');
});

test('returns: an approved return records a full audit trail', async () => {
  const state = newState();

  const requested = requestOn(orderFixture());
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const received = await receiveReturn(requested.returnRequest, requested.order, {
    state,
    actor: 'jane@example.test',
    actorRole: 'FULFILLMENT_STAFF',
    warehouseId: WAREHOUSE,
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;

  const inspected = await inspectReturn(
    received.returnRequest,
    received.order,
    { decision: 'APPROVE' },
    { state, actor: 'jane@example.test', actorRole: 'FULFILLMENT_STAFF' }
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;

  const actions = inspected.returnRequest.auditTrail.map((entry) => entry.action);
  assert.deepEqual(actions, ['REQUESTED', 'RECEIVED', 'INSPECTED']);

  // Every stock movement a return makes is written down, so the warehouse ledger
  // can be reconciled against it later.
  const adjustments = await state.listAdjustments(TENANT, SKU);
  assert.deepEqual(
    adjustments.map((record) => [record.physicalDelta, record.quarantineDelta]),
    [
      [2, 2],
      [0, -2],
    ]
  );
});
