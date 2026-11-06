/**
 * Contract tests for the durable commerce state.
 *
 * The same suite runs against the in-memory adapter (always) and against
 * Firestore (when FIRESTORE_EMULATOR_HOST is set), so both implementations are
 * held to identical behaviour: atomicity, expiry, idempotent commit, tenant
 * isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryCommerceState,
  computeAvailability,
  createConversationStockPort,
  planReservation,
  type CommerceState,
} from './commerceState.ts';
import type { Product, WarehouseInventory } from './types.ts';

function row(
  sku: string,
  overrides: Partial<WarehouseInventory> = {}
): WarehouseInventory {
  return {
    sku,
    warehouseId: 'WH-MAIN',
    warehouseName: 'Main Hub',
    physicalStock: 10,
    reservedStock: 0,
    quarantineStock: 0,
    lowStockThreshold: 3,
    lastReconciledAt: new Date().toISOString(),
    ...overrides,
  };
}

function product(sku: string, id = `prod-${sku.toLowerCase()}`): Product {
  return {
    id,
    tenantId: 'ignored',
    sku,
    title: `Product ${sku}`,
    description: '',
    category: 'TEST',
    basePriceCents: 4800,
    currency: 'KES',
    variants: [],
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  };
}

function runContract(label: string, create: () => CommerceState) {
  let sequence = 0;
  const nextTenant = () => `tenant-${label}-${++sequence}`;

  test(`${label}: aggregates availability across warehouses`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1', { warehouseId: 'WH-A', physicalStock: 10, reservedStock: 2 }));
    await state.upsertInventory(tenantId, row('SKU-1', { warehouseId: 'WH-B', physicalStock: 5, quarantineStock: 1 }));

    const availability = await state.getAvailability(tenantId, 'SKU-1');
    assert.equal(availability.physicalStock, 15);
    assert.equal(availability.reservedStock, 2);
    assert.equal(availability.quarantineStock, 1);
    assert.equal(availability.availableStock, 12);
  });

  test(`${label}: reserves stock and reports the remaining balance`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1'));

    const result = await state.reserve(tenantId, { orderId: 'ORD-000001', sku: 'SKU-1', quantity: 3 });

    assert.equal(result.success, true);
    assert.equal(result.scenario, 'AVAILABLE');
    assert.equal(result.availableStock, 7);
    assert.equal(result.reservation?.quantity, 3);
    assert.equal(result.reservation?.status, 'ACTIVE');
    assert.equal(result.reservation?.tenantId, tenantId);

    const after = await state.getAvailability(tenantId, 'SKU-1');
    assert.equal(after.reservedStock, 3);
    assert.equal(after.physicalStock, 10);
    assert.equal(after.availableStock, 7);
  });

  test(`${label}: refuses to reserve a sold-out SKU`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-EMPTY', { physicalStock: 0 }));

    const result = await state.reserve(tenantId, { orderId: 'ORD-000002', sku: 'SKU-EMPTY', quantity: 1 });
    assert.equal(result.success, false);
    assert.equal(result.scenario, 'OUT_OF_STOCK');
    assert.equal(result.availableStock, 0);
  });

  test(`${label}: reports the available portion when quantity exceeds stock`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1', { physicalStock: 4 }));

    const result = await state.reserve(tenantId, { orderId: 'ORD-000003', sku: 'SKU-1', quantity: 9 });
    assert.equal(result.success, false);
    assert.equal(result.scenario, 'QUANTITY_EXCEEDED');
    assert.equal(result.availableStock, 4);
  });

  test(`${label}: cannot oversell the final unit under concurrent requests`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-LAST', { physicalStock: 1 }));

    const [first, second] = await Promise.all([
      state.reserve(tenantId, { orderId: 'ORD-CUST-A', sku: 'SKU-LAST', quantity: 1 }),
      state.reserve(tenantId, { orderId: 'ORD-CUST-B', sku: 'SKU-LAST', quantity: 1 }),
    ]);

    const successes = [first, second].filter((result) => result.success);
    assert.equal(successes.length, 1, 'exactly one reservation may win the last unit');

    const availability = await state.getAvailability(tenantId, 'SKU-LAST');
    assert.equal(availability.availableStock, 0);
    assert.equal(availability.reservedStock, 1);
  });

  test(`${label}: expiry releases reserved stock back to availability`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1', { physicalStock: 5 }));

    const reserved = await state.reserve(tenantId, {
      orderId: 'ORD-EXPIRE',
      sku: 'SKU-1',
      quantity: 2,
      ttlMinutes: -1,
    });
    assert.equal(reserved.success, true);

    const released = await state.releaseExpired(tenantId);
    assert.equal(released, 1);

    const availability = await state.getAvailability(tenantId, 'SKU-1');
    assert.equal(availability.availableStock, 5);
    assert.equal(availability.reservedStock, 0);
  });

  test(`${label}: commit deducts physical stock exactly once`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1'));

    const reserved = await state.reserve(tenantId, { orderId: 'ORD-COMMIT', sku: 'SKU-1', quantity: 4 });
    const reservationId = reserved.reservation!.id;

    assert.equal(await state.commit(tenantId, reservationId), true);
    // Replaying the commit (duplicate webhook, retried request) must be a no-op.
    assert.equal(await state.commit(tenantId, reservationId), false);

    const availability = await state.getAvailability(tenantId, 'SKU-1');
    assert.equal(availability.physicalStock, 6);
    assert.equal(availability.reservedStock, 0);
    assert.equal(availability.availableStock, 6);
  });

  test(`${label}: cancel returns units without touching physical stock`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1'));

    const reserved = await state.reserve(tenantId, { orderId: 'ORD-CANCEL', sku: 'SKU-1', quantity: 2 });
    const reservationId = reserved.reservation!.id;

    assert.equal(await state.cancel(tenantId, reservationId), true);
    assert.equal(await state.cancel(tenantId, reservationId), false);

    const availability = await state.getAvailability(tenantId, 'SKU-1');
    assert.equal(availability.availableStock, 10);
    assert.equal(availability.physicalStock, 10);
  });

  test(`${label}: adjustments clamp at zero and are audited`, async () => {
    const state = create();
    const tenantId = nextTenant();
    await state.upsertInventory(tenantId, row('SKU-1', { physicalStock: 2 }));

    const updated = await state.adjust(tenantId, {
      sku: 'SKU-1',
      warehouseId: 'WH-MAIN',
      physicalDelta: -10,
      quarantineDelta: 1,
      reason: 'Stock count correction',
      actor: 'owner@sokoflow.test',
    });

    assert.equal(updated?.physicalStock, 0);
    assert.equal(updated?.quarantineStock, 1);

    const trail = await state.listAdjustments(tenantId, 'SKU-1');
    assert.equal(trail.length, 1);
    assert.equal(trail[0].reason, 'Stock count correction');
    assert.equal(trail[0].physicalDelta, -10);
  });

  test(`${label}: tenant records are isolated`, async () => {
    const state = create();
    const tenantA = nextTenant();
    const tenantB = nextTenant();
    await state.upsertInventory(tenantA, row('SKU-1', { physicalStock: 6 }));

    const result = await state.reserve(tenantB, { orderId: 'ORD-B', sku: 'SKU-1', quantity: 1 });
    assert.equal(result.success, false);
    assert.equal(result.scenario, 'WAREHOUSE_NOT_FOUND');

    const availableToA = await state.getAvailability(tenantA, 'SKU-1');
    assert.equal(availableToA.availableStock, 6);
  });

  test(`${label}: seeding only runs on an empty tenant`, async () => {
    const state = create();
    const tenantId = nextTenant();

    assert.equal(await state.seedInventoryIfEmpty(tenantId, [row('SKU-1')]), true);
    assert.equal(await state.seedInventoryIfEmpty(tenantId, [row('SKU-1')]), false);

    const rows = await state.listInventory(tenantId);
    assert.equal(rows.length, 1);
  });

  test(`${label}: catalogue upserts are keyed by SKU`, async () => {
    const state = create();
    const tenantId = nextTenant();

    await state.upsertProduct(tenantId, product('SKU-1', 'first-id'));
    await state.upsertProduct(tenantId, product('SKU-1', 'second-id'));

    const products = await state.listProducts(tenantId);
    assert.equal(products.length, 1);
    assert.equal(products[0].id, 'second-id');
  });
}

runContract('in-memory', () => new InMemoryCommerceState());

// Firestore adapter: real transactions against the emulator, skipped unless one
// is running (`firebase emulators:start --only firestore`).
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { FirestoreCommerceState } = await import('./firestoreCommerceState.ts');

  const app = getApps()[0] || initializeApp({ projectId: 'demo-sokoflow' });
  const db = getFirestore(app);

  runContract('firestore', () => new FirestoreCommerceState(db));
} else {
  test('firestore: contract suite skipped (set FIRESTORE_EMULATOR_HOST to run)', {
    skip: true,
  }, () => {
    // Guarded so the suite reports the skip explicitly instead of silently passing.
  });
}

test('domain: computeAvailability clamps and flags low stock', () => {
  const rows = [
    row('SKU-1', { warehouseId: 'WH-A', physicalStock: 3, reservedStock: 5 }),
    row('SKU-1', { warehouseId: 'WH-B', physicalStock: 0 }),
  ];
  const availability = computeAvailability(rows, 'SKU-1');
  assert.equal(availability.availableStock, 0);
  assert.equal(availability.isLowStock, false);
});

test('domain: planReservation rejects non-positive and fractional quantities', () => {
  const rows = [row('SKU-1')];
  assert.equal(planReservation(rows, { sku: 'SKU-1', quantity: 0 }).ok, false);
  assert.equal(planReservation(rows, { sku: 'SKU-1', quantity: 1.5 }).ok, false);
});

test('domain: planReservation prefers the first warehouse that can satisfy the line', () => {
  const rows = [
    row('SKU-1', { warehouseId: 'WH-A', physicalStock: 1 }),
    row('SKU-1', { warehouseId: 'WH-B', physicalStock: 8 }),
  ];
  const plan = planReservation(rows, { sku: 'SKU-1', quantity: 3 });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.plan.warehouseId, 'WH-B');
    assert.equal(plan.plan.updatedRow.reservedStock, 3);
  }
});

test('conversation port: snapshot reads stay synchronous, reserve delegates to the store', async () => {
  const state = new InMemoryCommerceState();
  const tenantId = 'tenant-port';
  await state.upsertInventory(tenantId, row('SKU-1', { physicalStock: 4 }));

  const port = createConversationStockPort({
    tenantId,
    rows: await state.listInventory(tenantId),
    reserve: (tenant, command) => state.reserve(tenant, command),
  });

  assert.equal(port.getAvailability('SKU-1').availableStock, 4);

  const result = await port.reserveStock({ orderId: 'ORD-PORT', sku: 'SKU-1', quantity: 1 });
  assert.equal(result.success, true);

  // The snapshot is intentionally stale: it reflects the read point in time.
  assert.equal(port.getAvailability('SKU-1').availableStock, 4);
  assert.equal((await state.getAvailability(tenantId, 'SKU-1')).availableStock, 3);
});
