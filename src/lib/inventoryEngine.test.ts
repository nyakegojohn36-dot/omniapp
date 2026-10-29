import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryStore } from './inventoryEngine.ts';
import type { WarehouseInventory } from './types.ts';

const seedInventories: WarehouseInventory[] = [
  {
    sku: 'TSHIRT001',
    warehouseId: 'WH-MAIN-US',
    warehouseName: 'Central Logistics Hub',
    physicalStock: 10,
    reservedStock: 0,
    quarantineStock: 0,
    lowStockThreshold: 3,
    lastReconciledAt: new Date().toISOString(),
  },
  {
    sku: 'OUTOFSTOCK001',
    warehouseId: 'WH-MAIN-US',
    warehouseName: 'Central Logistics Hub',
    physicalStock: 0,
    reservedStock: 0,
    quarantineStock: 0,
    lowStockThreshold: 2,
    lastReconciledAt: new Date().toISOString(),
  },
];

test('Inventory Engine - Scenario A: successfully reserves stock when available', () => {
  const store = new InventoryStore(seedInventories);
  const result = store.reserveStock({
    tenantId: 'tenant-1',
    orderId: 'ORD-000008',
    sku: 'TSHIRT001',
    quantity: 2,
  });

  assert.equal(result.success, true);
  assert.equal(result.scenario, 'AVAILABLE');
  assert.equal(result.availableStock, 8); // 10 - 2
  assert.equal(result.reservation?.quantity, 2);

  // Check store availability
  const check = store.getAvailability('TSHIRT001');
  assert.equal(check.availableStock, 8);
  assert.equal(check.reservedStock, 2);
  assert.equal(check.physicalStock, 10);
});

test('Inventory Engine - Scenario B: handles completely out-of-stock item safely', () => {
  const store = new InventoryStore(seedInventories);
  const result = store.reserveStock({
    tenantId: 'tenant-1',
    orderId: 'ORD-000009',
    sku: 'OUTOFSTOCK001',
    quantity: 1,
  });

  assert.equal(result.success, false);
  assert.equal(result.scenario, 'OUT_OF_STOCK');
  assert.equal(result.availableStock, 0);
  assert.match(result.error || '', /completely out of stock/);
});

test('Inventory Engine - Scenario C: detects when requested quantity exceeds available stock', () => {
  const store = new InventoryStore(seedInventories);
  const result = store.reserveStock({
    tenantId: 'tenant-1',
    orderId: 'ORD-000010',
    sku: 'TSHIRT001',
    quantity: 15,
  });

  assert.equal(result.success, false);
  assert.equal(result.scenario, 'QUANTITY_EXCEEDED');
  assert.equal(result.availableStock, 10);
  assert.match(result.error || '', /Requested 15 units, but only 10 units are available/);
});

test('Inventory Engine - Scenario H: race condition for final units (prevents overselling)', () => {
  const store = new InventoryStore([
    {
      sku: 'FINAL_UNIT_SKU',
      warehouseId: 'WH-1',
      warehouseName: 'Main',
      physicalStock: 1,
      reservedStock: 0,
      quarantineStock: 0,
      lowStockThreshold: 1,
      lastReconciledAt: new Date().toISOString(),
    },
  ]);

  // Customer A reserves the 1 unit
  const reqA = store.reserveStock({
    tenantId: 't1',
    orderId: 'ORD-CUST-A',
    sku: 'FINAL_UNIT_SKU',
    quantity: 1,
  });

  assert.equal(reqA.success, true);
  assert.equal(reqA.availableStock, 0);

  // Customer B attempts to reserve the same unit simultaneously
  const reqB = store.reserveStock({
    tenantId: 't1',
    orderId: 'ORD-CUST-B',
    sku: 'FINAL_UNIT_SKU',
    quantity: 1,
  });

  assert.equal(reqB.success, false);
  assert.equal(reqB.scenario, 'OUT_OF_STOCK');
  assert.equal(reqB.availableStock, 0);
});

test('Inventory Engine - Scenario I: releases expired reservations (TTL)', () => {
  const store = new InventoryStore(seedInventories);

  // Reserve with negative TTL (already expired)
  const result = store.reserveStock({
    tenantId: 'tenant-1',
    orderId: 'ORD-EXPIRE-TEST',
    sku: 'TSHIRT001',
    quantity: 3,
    ttlMinutes: -1, // Expired immediately
  });

  assert.equal(result.success, true);

  // Cleanup runs and releases stock
  const released = store.cleanExpiredReservations();
  assert.equal(released, 1);

  const check = store.getAvailability('TSHIRT001');
  assert.equal(check.availableStock, 10); // Full stock restored
  assert.equal(check.reservedStock, 0);
});

test('Inventory Engine: commit turns reservation into physical stock deduction', () => {
  const store = new InventoryStore(seedInventories);

  const res = store.reserveStock({
    tenantId: 'tenant-1',
    orderId: 'ORD-COMMIT-TEST',
    sku: 'TSHIRT001',
    quantity: 4,
  });

  assert.equal(res.success, true);
  const committed = store.commitReservation(res.reservation!.id);
  assert.equal(committed, true);

  const check = store.getAvailability('TSHIRT001');
  assert.equal(check.physicalStock, 6); // 10 - 4
  assert.equal(check.reservedStock, 0);
  assert.equal(check.availableStock, 6);
});
