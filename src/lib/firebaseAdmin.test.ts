import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
  getTenantOrder,
  listTenantOrders,
  listTenantReturns,
  nextOrderSequence,
  requireRoles,
  saveOrder,
  setFirestoreForTests,
} from './firebaseAdmin.ts';
import { CommerceStateUnavailableError } from './commerceState.ts';
import { SEED_ORDERS } from './sampleData.ts';
import type { Firestore } from 'firebase-admin/firestore';

test('Firebase API role guard rejects missing and customer roles', () => {
  const guard = requireRoles('BUSINESS_OWNER');
  let statusCode = 0;
  let responseBody: unknown;
  let nextCalled = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as Response;

  guard({} as Request, response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(statusCode, 403);
  assert.deepEqual(responseBody, {
    error: 'You do not have permission to perform this action.',
  });
  assert.equal(nextCalled, false);

  guard(
    { authUser: { role: 'CUSTOMER' } } as Request,
    response,
    (() => { nextCalled = true; }) as NextFunction
  );
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
});

test('Firebase API role guard accepts an authorized server-side role', () => {
  const guard = requireRoles('BUSINESS_OWNER');
  let nextCalled = false;
  let statusCode = 0;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as Response;

  guard(
    { authUser: { role: 'BUSINESS_OWNER' } } as Request,
    response,
    (() => { nextCalled = true; }) as NextFunction
  );
  assert.equal(statusCode, 0);
  assert.equal(nextCalled, true);
});

const unavailable = (error: Error) => error instanceof CommerceStateUnavailableError;

/**
 * A database whose every read and write rejects: what an unreachable Firestore
 * looks like to these helpers. A real one cannot be used here, because gRPC
 * retries a dead endpoint for minutes instead of rejecting.
 */
function unreachableFirestore(): Firestore {
  const rejected = () => Promise.reject(new Error('14 UNAVAILABLE: failed to connect to all addresses'));
  type Chain = { where: () => Chain; limit: () => Chain; get: () => Promise<never> };
  const query: Chain = { where: () => query, limit: () => query, get: rejected };
  const document = {
    get: rejected,
    set: rejected,
    create: rejected,
    update: rejected,
    delete: rejected,
  };
  const collection = { doc: () => document, where: () => query, get: rejected };
  return {
    collection: () => collection,
    batch: () => ({ set: () => undefined, commit: rejected }),
    runTransaction: rejected,
  } as unknown as Firestore;
}

test('firebaseAdmin: an unreachable order store fails closed, not back to memory', async () => {
  process.env.COMMERCE_STATE_BACKEND = 'firestore';
  setFirestoreForTests(unreachableFirestore());
  const order = SEED_ORDERS[0];

  try {
    await assert.rejects(
      () => saveOrder(order),
      unavailable,
      'a failed order write must surface as a 503-mapped error, not a silent memory write'
    );
    await assert.rejects(
      () => listTenantOrders(order.tenantId),
      unavailable,
      'an unreachable store must not read back as an empty order list'
    );
    await assert.rejects(
      () => nextOrderSequence(order.tenantId),
      unavailable,
      'order numbers must not be allocated against a store that cannot commit'
    );
  } finally {
    setFirestoreForTests(null);
  }
});

test('firebaseAdmin: an unreachable return store fails closed too', async () => {
  process.env.COMMERCE_STATE_BACKEND = 'firestore';
  setFirestoreForTests(unreachableFirestore());

  try {
    await assert.rejects(() => listTenantReturns('tenant-nordic'), unavailable);
  } finally {
    setFirestoreForTests(null);
  }
});

test('firebaseAdmin: memory mode never touches the database, by explicit opt-in', async () => {
  process.env.COMMERCE_STATE_BACKEND = 'memory';
  // The same database that fails the tests above: memory mode must not reach it.
  setFirestoreForTests(unreachableFirestore());
  const order = {
    ...SEED_ORDERS[0],
    id: `ORD-MEM-${Date.now()}`,
    tenantId: 'tenant-memory-test',
  };

  try {
    await saveOrder(order);

    const loaded = await getTenantOrder(order.tenantId, order.id);
    assert.equal(loaded?.id, order.id);
    const listed = await listTenantOrders(order.tenantId);
    assert.ok(listed.some((candidate) => candidate.id === order.id));
  } finally {
    setFirestoreForTests(null);
    delete process.env.COMMERCE_STATE_BACKEND;
  }
});
