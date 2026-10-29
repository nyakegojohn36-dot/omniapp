import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyStore } from './idempotency.ts';

test('Idempotency Store: acquires new lock and caches resolved responses', () => {
  const store = new IdempotencyStore();

  const firstCheck = store.acquire('tenant-1', 'CREATE_ORDER', 'idemp-req-12345');
  assert.equal(firstCheck.status, 'NEW');

  // Second immediate attempt while in-flight
  const inFlightCheck = store.acquire('tenant-1', 'CREATE_ORDER', 'idemp-req-12345');
  assert.equal(inFlightCheck.status, 'IN_FLIGHT');

  // Resolve operation with order result
  store.resolve('tenant-1', 'CREATE_ORDER', 'idemp-req-12345', { orderId: 'ORD-000008' });

  // Third attempt should return cached response without re-executing
  const cachedCheck = store.acquire<{ orderId: string }>('tenant-1', 'CREATE_ORDER', 'idemp-req-12345');
  assert.equal(cachedCheck.status, 'CACHED');
  assert.equal(cachedCheck.cachedResponse?.orderId, 'ORD-000008');
});

test('Idempotency Store: isolates idempotency keys between different tenants', () => {
  const store = new IdempotencyStore();

  store.acquire('tenant-A', 'CHARGE_PAYMENT', 'tx-999');
  store.resolve('tenant-A', 'CHARGE_PAYMENT', 'tx-999', { charged: true, merchant: 'A' });

  // Same key under tenant-B must be completely separate
  const tenantBCheck = store.acquire('tenant-B', 'CHARGE_PAYMENT', 'tx-999');
  assert.equal(tenantBCheck.status, 'NEW');
});
