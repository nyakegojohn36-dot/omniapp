import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
  getTenantOrder,
  listTenantOrders,
  listTenantReturns,
  nextOrderSequence,
  provisionTenantForOwner,
  requireRoles,
  saveOrder,
  setFirestoreForTests,
  WorkspaceProvisioningConflictError,
} from './firebaseAdmin.ts';
import { CommerceStateUnavailableError } from './commerceState.ts';
import { SEED_ORDERS } from './sampleData.ts';
import type { Firestore } from 'firebase-admin/firestore';
import type { Tenant } from './types.ts';

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

test('firebaseAdmin: workspace provisioning fails closed when Firestore is unavailable', async () => {
  setFirestoreForTests(unreachableFirestore());

  try {
    await assert.rejects(
      () => provisionTenantForOwner({} as Tenant, 'unreachable-owner'),
      unavailable
    );
  } finally {
    setFirestoreForTests(null);
  }
});

if (process.env.FIRESTORE_EMULATOR_HOST) {
  test('firebaseAdmin: creates a tenant and its initial owner atomically', async () => {
    const { getApps, initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const app = getApps()[0] || initializeApp({ projectId: 'demo-sokoflow' });
    const db = getFirestore(app);
    const ownerId = `onboarding-owner-${Date.now()}`;
    const tenantId = `tenant-onboarding-${Date.now()}`;
    const tenant: Tenant = {
      id: tenantId,
      name: 'Onboarding Test Workspace',
      slug: `onboarding-${Date.now()}`,
      currency: 'KES',
      locale: 'en-KE',
      timezone: 'Africa/Nairobi',
      taxRatePercent: 0,
      taxInclusive: true,
      reservationTTLMinutes: 15,
      channels: ['WEB'],
    };

    setFirestoreForTests(db);
    try {
      await db.collection('users').doc(ownerId).set({
        id: ownerId,
        tenantId: 'tenant-nordic',
        name: 'Workspace Owner',
        email: `${ownerId}@example.test`,
        role: 'CUSTOMER',
      });

      const owner = await provisionTenantForOwner(tenant, ownerId);
      assert.equal(owner.role, 'BUSINESS_OWNER');
      assert.equal(owner.tenantId, tenantId);
      assert.equal((await db.collection('tenants').doc(tenantId).get()).exists, true);

      const retriedOwner = await provisionTenantForOwner(
        { ...tenant, name: 'Ignored Retry Name' },
        ownerId
      );
      assert.equal(retriedOwner.role, 'BUSINESS_OWNER');
      assert.equal(
        (await db.collection('tenants').doc(tenantId).get()).data()?.name,
        tenant.name
      );

      const savedProfile = (await db.collection('users').doc(ownerId).get()).data();
      assert.equal(savedProfile?.role, 'BUSINESS_OWNER');
      assert.equal(savedProfile?.tenantId, tenantId);

      const secondTenant = { ...tenant, id: `${tenantId}-second`, slug: `${tenant.slug}-second` };
      await assert.rejects(
        () => provisionTenantForOwner(secondTenant, ownerId),
        (error: unknown) => error instanceof WorkspaceProvisioningConflictError
      );
      assert.equal((await db.collection('tenants').doc(secondTenant.id).get()).exists, false);
    } finally {
      await db.collection('users').doc(ownerId).delete();
      await db.collection('tenants').doc(tenantId).delete();
      setFirestoreForTests(null);
    }
  });
} else {
  test('firebaseAdmin: tenant-owner provisioning contract requires Firestore emulator', {
    skip: true,
  }, () => {});
}

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
