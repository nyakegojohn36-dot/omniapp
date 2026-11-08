import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import {
  allowsUnverifiedOnboardingRequest,
  canManageSharedWhatsApp,
  getPendingBusinessWorkspace,
  savePendingBusinessWorkspace,
  requireSharedWhatsAppAccess,
  sharedWhatsAppAccessPolicy,
  type AuthenticatedUser,
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

test('firebaseAdmin: pending onboarding fails closed when Firestore is unavailable', async () => {
  setFirestoreForTests(unreachableFirestore());
  try {
    await assert.rejects(() => getPendingBusinessWorkspace('customer'), unavailable);
    await assert.rejects(() => savePendingBusinessWorkspace('customer', { businessName: 'Acacia', currency: 'KES' }), unavailable);
  } finally { setFirestoreForTests(null); }
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

function withProviderConfiguration(run: () => void) {
  const old = { OWNER_EMAILS: process.env.OWNER_EMAILS, DEFAULT_TENANT_ID: process.env.DEFAULT_TENANT_ID };
  process.env.OWNER_EMAILS = 'operator@example.test';
  process.env.DEFAULT_TENANT_ID = 'tenant-shared';
  try { run(); } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const providerOperator: AuthenticatedUser = {
  id: 'operator', name: 'Operator', email: 'operator@example.test',
  role: 'BUSINESS_OWNER', tenantId: 'tenant-shared', emailVerified: true,
};

test('shared WhatsApp capability denies self-service owners, staff and unverified operators', () => {
  withProviderConfiguration(() => {
    const denied: Array<AuthenticatedUser | undefined> = [
      undefined,
      { ...providerOperator, role: 'CUSTOMER' },
      { ...providerOperator, role: 'SUPPORT_STAFF' },
      { ...providerOperator, email: 'self-service@example.test' },
      { ...providerOperator, tenantId: 'tenant-self-service' },
      { ...providerOperator, emailVerified: false },
      { ...providerOperator, role: 'SUPER_ADMIN', emailVerified: false },
    ];
    for (const user of denied) {
      assert.equal(canManageSharedWhatsApp(user), false);
      let status = 0;
      let nextCalled = false;
      const response = { status(code: number) { status = code; return this; }, json() { return this; } } as Response;
      requireSharedWhatsAppAccess({ authUser: user } as Request, response, (() => { nextCalled = true; }) as NextFunction);
      assert.equal(status, 403);
      assert.equal(nextCalled, false);
    }
  });
});

test('shared WhatsApp capability permits verified platform administrators and default-tenant allowlisted owners', () => {
  withProviderConfiguration(() => {
    const allowed = [providerOperator,
      { ...providerOperator, email: '  OPERATOR@example.test  ' },
      { ...providerOperator, role: 'SUPER_ADMIN' as const, tenantId: 'tenant-admin', email: 'admin@example.test' },
    ];
    for (const user of allowed) {
      assert.equal(canManageSharedWhatsApp(user), true);
      let nextCalled = false;
      requireSharedWhatsAppAccess({ authUser: user } as Request, { status: assert.fail } as unknown as Response,
        (() => { nextCalled = true; }) as NextFunction);
      assert.equal(nextCalled, true);
    }
    process.env.OWNER_EMAILS = '';
    const previousEmail = process.env.OWNER_EMAIL;
    delete process.env.OWNER_EMAIL;
    try { assert.equal(canManageSharedWhatsApp(providerOperator), false); } finally {
      if (previousEmail !== undefined) process.env.OWNER_EMAIL = previousEmail;
    }
  });
});

test('shared WhatsApp HTTP policy guards all controls, including future routes, inside the API mount', async () => {
  const app = express();
  app.use('/api', (req, _res, next) => {
    req.authUser = { ...providerOperator, tenantId: 'tenant-other', email: 'self-service@example.test' };
    next();
  });
  app.use('/api/whatsapp', sharedWhatsAppAccessPolicy);
  app.all('/api/whatsapp/*', (_req, res) => { res.json({ allowed: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/whatsapp`;
  try {
    for (const [method, path] of [
      ['POST', '/config'], ['POST', '/send'], ['POST', '/messages'], ['GET', '/logs'],
      ['POST', '/reset'], ['GET', '/status'], ['POST', '/verify-code'],
      ['POST', '/request-code'], ['POST', '/register'], ['DELETE', '/future-operation'],
      ['POST', '/webhook'], ['POST', '/config/'],
    ]) {
      assert.equal((await fetch(base + path, { method })).status, 403, `${method} ${path}`);
    }
    for (const path of ['/config', '/messages', '/config/', '/messages?tenantId=another']) {
      assert.equal((await fetch(base + path)).status, 200, `tenant-safe read ${path}`);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('unverified onboarding exception uses original URL and never permits provisioning or commerce access', async () => {
  const app = express();
  app.use('/api', (req, res) => { res.sendStatus(allowsUnverifiedOnboardingRequest(req) ? 200 : 403); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, path, status] of [
      ['GET', '/api/auth/me', 200], ['GET', '/api/auth/me?refresh=1', 200],
      ['GET', '/api/onboarding/business/pending', 200], ['PUT', '/api/onboarding/business/pending/', 200],
      ['POST', '/api/onboarding/business', 403], ['GET', '/api/products', 403],
      ['POST', '/api/auth/me', 403], ['PUT', '/api/onboarding/business/pending/other', 403],
    ] as const) {
      assert.equal((await fetch(base + path, { method })).status, status, `${method} ${path}`);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

/** Transaction fixture buffers writes until commit and forbids reads after writes. */
function transactionalFirestoreFixture() {
  type RecordData = Record<string, unknown>;
  type Ref = { path: string; get: () => Promise<{ exists: boolean; data: () => RecordData | undefined }> };
  const records = new Map<string, RecordData>();
  const db = {
    collection: (collection: string) => ({ doc: (id: string): Ref => {
      const path = `${collection}/${id}`;
      return { path, get: async () => ({ exists: records.has(path), data: () => records.get(path) }) };
    } }),
    runTransaction: async (run: (transaction: unknown) => Promise<unknown>) => {
      const writes: Array<() => void> = [];
      const transaction = {
        get: (ref: Ref) => { assert.equal(writes.length, 0, 'reads must precede writes'); return ref.get(); },
        set: (ref: Ref, data: RecordData) => writes.push(() => records.set(ref.path, structuredClone(data))),
        create: (ref: Ref, data: RecordData) => {
          assert.equal(records.has(ref.path), false);
          writes.push(() => records.set(ref.path, structuredClone(data)));
        },
        update: (ref: Ref, data: RecordData) => writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })),
        delete: (ref: Ref) => writes.push(() => records.delete(ref.path)),
      };
      const result = await run(transaction);
      for (const write of writes) write();
      return result;
    },
  } as unknown as Firestore;
  return { db, records };
}

test('onboarding drafts persist per UID, reject noncustomers and clear with atomic/idempotent provisioning', async () => {
  const { db, records } = transactionalFirestoreFixture();
  const draft = { businessName: 'Acacia Market', currency: 'KES' };
  for (const id of ['customer-a', 'customer-b']) records.set(`users/${id}`, { ...providerOperator, id, role: 'CUSTOMER' });
  records.set('users/staff', { ...providerOperator, role: 'SUPPORT_STAFF' });
  const tenant: Tenant = {
    id: 'tenant-acacia', name: draft.businessName, slug: 'acacia', currency: 'KES',
    locale: 'en-KE', timezone: 'Africa/Nairobi', taxRatePercent: 0, taxInclusive: true,
    reservationTTLMinutes: 15, channels: ['WEB'],
  };
  setFirestoreForTests(db);
  try {
    assert.equal(await getPendingBusinessWorkspace('customer-a'), null);
    await savePendingBusinessWorkspace('customer-a', draft);
    const firstDraftKey = [...records.keys()].find((key) => key.startsWith('businessOnboarding/'))!;
    await savePendingBusinessWorkspace('customer-b', { ...draft, businessName: 'Another Business' });
    // Fresh helpers read back account-scoped state without a browser-local cache.
    assert.deepEqual(await getPendingBusinessWorkspace('customer-a'), draft);
    assert.deepEqual(await getPendingBusinessWorkspace('customer-b'), { ...draft, businessName: 'Another Business' });
    assert.equal(await getPendingBusinessWorkspace('unrelated'), null);
    await assert.rejects(() => savePendingBusinessWorkspace('staff', draft), WorkspaceProvisioningConflictError);
    await assert.rejects(() => savePendingBusinessWorkspace('missing', draft), WorkspaceProvisioningConflictError);

    records.set(`tenants/${tenant.id}`, { ...tenant });
    await assert.rejects(() => provisionTenantForOwner(tenant, 'customer-a'), WorkspaceProvisioningConflictError);
    assert.deepEqual(await getPendingBusinessWorkspace('customer-a'), draft, 'failed provisioning retains draft');
    assert.equal(records.get('users/customer-a')?.role, 'CUSTOMER');
    records.delete(`tenants/${tenant.id}`);

    const owner = await provisionTenantForOwner(tenant, 'customer-a');
    assert.equal(owner.role, 'BUSINESS_OWNER');
    assert.equal(owner.tenantId, tenant.id);
    assert.equal(await getPendingBusinessWorkspace('customer-a'), null);
    assert.equal((await getPendingBusinessWorkspace('customer-b'))?.businessName, 'Another Business');
    await assert.rejects(() => savePendingBusinessWorkspace('customer-a', draft), WorkspaceProvisioningConflictError);
    records.set(firstDraftKey, { ...draft });
    await provisionTenantForOwner(tenant, 'customer-a');
    assert.equal(await getPendingBusinessWorkspace('customer-a'), null);
    assert.deepEqual(records.get(`tenants/${tenant.id}`), tenant);
    assert.equal([...records.keys()].filter((key) => key.startsWith('tenants/')).length, 1);
  } finally { setFirestoreForTests(null); }
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

      await savePendingBusinessWorkspace(ownerId, { businessName: tenant.name, currency: tenant.currency });
      assert.equal((await getPendingBusinessWorkspace(ownerId))?.businessName, tenant.name);
      const owner = await provisionTenantForOwner(tenant, ownerId);
      assert.equal(await getPendingBusinessWorkspace(ownerId), null);
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
