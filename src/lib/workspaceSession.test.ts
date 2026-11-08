import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCoordinator, loadWorkspaceSession } from './workspaceSession.ts';
import type { User } from './types.ts';

const customer: User = {
  id: 'account-a', tenantId: 'tenant-default', name: 'New Owner',
  email: 'owner@example.test', role: 'CUSTOMER', emailVerified: true,
  canManageSharedWhatsApp: false,
};
const pendingWorkspace = { businessName: 'Acacia Market', currency: 'KES' };

function requests(answers: Array<{ path: string; body: unknown; status?: number; method?: string }>) {
  const remaining = [...answers];
  return {
    request: async (path: string, init?: RequestInit) => {
      const expected = remaining.shift();
      assert.ok(expected, `Unexpected request: ${path}`);
      assert.equal(path, expected.path);
      assert.equal(init?.method ?? 'GET', expected.method ?? 'GET');
      if (expected.method === 'POST') assert.deepEqual(JSON.parse(String(init?.body)), {});
      return Response.json(expected.body, { status: expected.status ?? 200 });
    },
    complete: () => assert.equal(remaining.length, 0),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('session: a customer without a draft loads the authoritative matching tenant', async () => {
  const mock = requests([
    { path: '/api/auth/me', body: { user: customer } },
    { path: '/api/onboarding/business/pending', body: { pendingWorkspace: null } },
    { path: '/api/tenant', body: { tenant: { id: customer.tenantId } } },
  ]);
  const session = await loadWorkspaceSession(mock.request);
  assert.deepEqual(session.user, customer);
  assert.equal(session.tenant?.id, customer.tenantId);
  assert.equal(session.pendingWorkspace, null);
  mock.complete();
});

test('session: unverified business setup resumes from the account without provisioning', async () => {
  const mock = requests([
    { path: '/api/auth/me', body: { user: { ...customer, emailVerified: false } } },
    { path: '/api/onboarding/business/pending', body: { pendingWorkspace } },
  ]);
  const session = await loadWorkspaceSession(mock.request);
  assert.equal(session.tenant, null);
  assert.deepEqual(session.pendingWorkspace, pendingWorkspace);
  mock.complete();
});

for (const serverRequiresVerification of [false, true]) {
  test(`session: verification gate works with ${serverRequiresVerification ? 'server' : 'frontend'} configuration`, async () => {
    const mock = requests([
      { path: '/api/auth/me', body: {
        user: { ...customer, emailVerified: false }, requiresEmailVerification: serverRequiresVerification,
      } },
      { path: '/api/onboarding/business/pending', body: { pendingWorkspace: null } },
    ]);
    assert.equal((await loadWorkspaceSession(mock.request, !serverRequiresVerification)).tenant, null);
    mock.complete();
  });
}

test('session: verified draft provisions once and reloads role, tenant and provider permission', async () => {
  const owner = { ...customer, role: 'BUSINESS_OWNER', tenantId: 'tenant-new', canManageSharedWhatsApp: false };
  const mock = requests([
    { path: '/api/auth/me', body: { user: customer } },
    { path: '/api/onboarding/business/pending', body: { pendingWorkspace } },
    { path: '/api/onboarding/business', method: 'POST', body: { user: customer } },
    { path: '/api/auth/me', body: { user: owner } },
    { path: '/api/tenant', body: { tenant: { id: owner.tenantId } } },
  ]);
  const session = await loadWorkspaceSession(mock.request);
  assert.deepEqual(session.user, owner);
  assert.equal(session.tenant?.id, owner.tenantId);
  assert.equal(session.pendingWorkspace, null);
  mock.complete();
});

test('session: existing owner restoration does not rerun onboarding', async () => {
  const owner = { ...customer, role: 'BUSINESS_OWNER' };
  const mock = requests([
    { path: '/api/auth/me', body: { user: owner } },
    { path: '/api/onboarding/business/pending', body: { pendingWorkspace: null } },
    { path: '/api/tenant', body: { tenant: { id: owner.tenantId } } },
  ]);
  assert.deepEqual((await loadWorkspaceSession(mock.request)).user, owner);
  mock.complete();
});

test('session: mismatched account and workspace are rejected', async () => {
  const mock = requests([
    { path: '/api/auth/me', body: { user: customer } },
    { path: '/api/onboarding/business/pending', body: { pendingWorkspace: null } },
    { path: '/api/tenant', body: { tenant: { id: 'another-business' } } },
  ]);
  await assert.rejects(() => loadWorkspaceSession(mock.request), /account and workspace do not match/);
});

test('session: draft storage failure never silently opens the default storefront', async () => {
  const mock = requests([
    { path: '/api/auth/me', body: { user: customer } },
    { path: '/api/onboarding/business/pending', status: 503, body: { error: 'Draft storage unavailable.' } },
  ]);
  await assert.rejects(() => loadWorkspaceSession(mock.request), /Draft storage unavailable/);
  mock.complete();
});

test('session: failed provisioning never applies the old customer profile', async () => {
  const mock = requests([
    { path: '/api/auth/me', body: { user: customer } },
    { path: '/api/onboarding/business/pending', body: { pendingWorkspace } },
    { path: '/api/onboarding/business', method: 'POST', status: 503, body: { error: 'Provisioning unavailable.' } },
  ]);
  await assert.rejects(() => loadWorkspaceSession(mock.request), /Provisioning unavailable/);
  mock.complete();
});

test('coordinator: slow customer restoration cannot replace a newly provisioned owner', async () => {
  const old = deferred<string>();
  const applied: Array<string | null> = [];
  const errors: unknown[] = [];
  const coordinator = createSessionCoordinator<string, string>(
    (identity) => identity === 'old-customer' ? old.promise : Promise.resolve('new-owner'),
    (session) => applied.push(session), (error) => errors.push(error)
  );
  const stale = coordinator.restore('old-customer');
  await coordinator.restore('new-owner');
  old.resolve('old-customer');
  await stale;
  assert.deepEqual(applied, ['new-owner']);
  assert.deepEqual(errors, []);
});

test('coordinator: a stale failure cannot sign out or clear a newer account', async () => {
  const old = deferred<string>();
  const applied: Array<string | null> = [];
  const errors: unknown[] = [];
  const coordinator = createSessionCoordinator<string, string>(
    (identity) => identity === 'old' ? old.promise : Promise.resolve(identity),
    (session) => applied.push(session), (error) => errors.push(error)
  );
  const stale = coordinator.restore('old');
  await coordinator.restore('new');
  old.reject(new Error('old profile unavailable'));
  await stale;
  assert.deepEqual(applied, ['new']);
  assert.deepEqual(errors, []);
});

test('coordinator: sign-out invalidates an in-flight restoration', async () => {
  const old = deferred<string>();
  const applied: Array<string | null> = [];
  const coordinator = createSessionCoordinator<string, string>(
    () => old.promise, (session) => applied.push(session), () => assert.fail('Unexpected session error')
  );
  const stale = coordinator.restore('old');
  await coordinator.restore(null);
  old.resolve('old');
  await stale;
  assert.deepEqual(applied, [null]);
});

test('coordinator: suspend blocks auth callbacks until profile updates and draft saving finish', async () => {
  const old = deferred<string>();
  const loads: string[] = [];
  const starts: Array<string | null> = [];
  const applied: Array<string | null> = [];
  const coordinator = createSessionCoordinator<string, string>(
    (identity) => {
      assert.equal(starts.at(-1), identity, 'old views must be hidden before profile loading');
      loads.push(identity);
      return identity === 'old' ? old.promise : Promise.resolve(identity);
    },
    (session) => applied.push(session), () => assert.fail('Unexpected session error'),
    (identity) => starts.push(identity)
  );
  const stale = coordinator.restore('old');
  coordinator.suspend();
  await coordinator.restore('partial-signup');
  await coordinator.restore(null);
  old.resolve('old');
  await stale;
  assert.deepEqual(applied, []);
  await coordinator.resume('saved-business-draft');
  assert.deepEqual(loads, ['old', 'saved-business-draft']);
  assert.deepEqual(starts, ['old', 'saved-business-draft']);
  assert.deepEqual(applied, ['saved-business-draft']);
});

test('coordinator: current errors surface, but unmount invalidates later callbacks', async () => {
  const delayed = deferred<string>();
  const errors: unknown[] = [];
  const coordinator = createSessionCoordinator<string, string>(
    (identity) => identity === 'fail' ? Promise.reject(new Error('Current failure')) : delayed.promise,
    () => assert.fail('Unexpected session application'), (error) => errors.push(error)
  );
  await coordinator.restore('fail');
  assert.equal((errors[0] as Error).message, 'Current failure');
  const pending = coordinator.restore('unmount');
  coordinator.invalidate();
  delayed.reject(new Error('Stale failure'));
  await pending;
  assert.equal(errors.length, 1);
});
