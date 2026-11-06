/**
 * Contract tests for tenant records.
 *
 * Same arrangement as the commerce state suite: one shared contract runs against
 * the in-memory repository always, and against Firestore when
 * FIRESTORE_EMULATOR_HOST is set. The regression that motivated this file is
 * covered explicitly - an unknown tenant must raise, never resolve to a default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTenantRepository,
  normalizeTenant,
  TenantValidationError,
  UnknownTenantError,
  type TenantRepository,
} from './tenantRepository.ts';
import type { Tenant } from './types.ts';

function tenant(id: string, overrides: Partial<Tenant> = {}): Tenant {
  return {
    id,
    name: `Workspace ${id}`,
    slug: id,
    currency: 'KES',
    locale: 'en-KE',
    timezone: 'Africa/Nairobi',
    taxRatePercent: 16,
    taxInclusive: true,
    reservationTTLMinutes: 15,
    plan: 'GROWTH',
    aiBudgetRemaining: 250,
    channels: ['WEB', 'WHATSAPP'],
    ...overrides,
  };
}

function runContract(label: string, create: () => TenantRepository, uniqueId: () => string) {
  test(`${label}: an unknown tenant raises instead of falling back to a default`, async () => {
    const repo = create();
    assert.equal(await repo.get('tenant-does-not-exist'), null);
    await assert.rejects(
      () => repo.require('tenant-does-not-exist'),
      (error: unknown) => error instanceof UnknownTenantError
    );
  });

  test(`${label}: creates, reads back, and refuses a duplicate id`, async () => {
    const repo = create();
    const id = uniqueId();
    const created = await repo.create(tenant(id, { taxRatePercent: 8 }));

    assert.equal(created.id, id);
    assert.equal(created.taxRatePercent, 8);
    assert.equal((await repo.require(id)).name, `Workspace ${id}`);
    await assert.rejects(() => repo.create(tenant(id)), TenantValidationError);
  });

  test(`${label}: a partial update keeps untouched settings`, async () => {
    const repo = create();
    const id = uniqueId();
    await repo.create(tenant(id, { reservationTTLMinutes: 15, plan: 'STARTER' }));

    const updated = await repo.update(id, { name: 'Renamed Workspace' });

    assert.equal(updated.name, 'Renamed Workspace');
    assert.equal(updated.reservationTTLMinutes, 15);
    assert.equal(updated.plan, 'STARTER');
    assert.equal(updated.id, id);
  });

  test(`${label}: an update cannot change the tenant id`, async () => {
    const repo = create();
    const id = uniqueId();
    await repo.create(tenant(id));
    const updated = await repo.update(id, { id: 'tenant-hijacked', name: 'Still Mine' });
    assert.equal(updated.id, id);
  });

  test(`${label}: seeding writes once and never overwrites`, async () => {
    const repo = create();
    const id = uniqueId();
    const seeded = await repo.seedIfEmpty([tenant(id, { name: 'Seed Name' })]);
    assert.equal(seeded, true);

    const second = await repo.seedIfEmpty([tenant(id, { name: 'Second Name' })]);
    assert.equal(second, false);
    assert.equal((await repo.require(id)).name, 'Seed Name');
  });
}

runContract(
  'in-memory',
  () => new InMemoryTenantRepository(),
  (() => {
    let n = 0;
    return () => `tenant-mem-${++n}`;
  })()
);

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { FirestoreTenantRepository } = await import('./tenantRepository.ts');

  const app = getApps()[0] || initializeApp({ projectId: 'demo-sokoflow' });
  const db = getFirestore(app);
  let n = 0;
  // Each repository gets its own collection. "Seed only when the collection is
  // empty" is a statement about a whole collection, so sharing one with the
  // other cases in this suite would make the assertion depend on test order.
  let collectionRun = 0;
  runContract(
    'firestore',
    () =>
      new FirestoreTenantRepository(
        db,
        0,
        `tenants-contract-${Date.now()}-${++collectionRun}`
      ),
    () => `tenant-fs-${++n}`
  );
} else {
  test('firestore tenants: contract suite skipped (set FIRESTORE_EMULATOR_HOST to run)', {
    skip: true,
  }, () => {
    // Guarded so the suite reports the skip explicitly instead of silently passing.
  });
}

test('tenants: a minimal payload resolves to safe Kenyan defaults', () => {
  const resolved = normalizeTenant({ id: 'tenant-new', name: 'New Shop', currency: 'kes' });

  assert.equal(resolved.currency, 'KES');
  assert.equal(resolved.locale, 'en-KE');
  assert.equal(resolved.timezone, 'Africa/Nairobi');
  assert.equal(resolved.reservationTTLMinutes, 15);
  assert.equal(resolved.plan, 'STARTER');
  assert.equal(resolved.taxInclusive, true);
  assert.deepEqual(resolved.channels, ['WEB', 'WHATSAPP']);
  assert.equal(resolved.slug, 'tenant-new');
});

test('tenants: rejects a tax rate outside 0-100 instead of clamping it', () => {
  assert.throws(() => normalizeTenant({ id: 'tenant-a', name: 'A', currency: 'KES', taxRatePercent: 160 }), (error: unknown) => {
    return error instanceof TenantValidationError && error.field === 'taxRatePercent';
  });
});

test('tenants: rejects a fractional or out-of-range reservation TTL', () => {
  for (const reservationTTLMinutes of [0, 1.5, 241]) {
    assert.throws(
      () => normalizeTenant({ id: 'tenant-a', name: 'A', currency: 'KES', reservationTTLMinutes }),
      TenantValidationError
    );
  }
});

test('tenants: rejects an id that could collide with routing or storage', () => {
  for (const id of ['', 'Tenant With Spaces', 'a', '../etc', 'tenant_underscore']) {
    assert.throws(() => normalizeTenant({ id, name: 'A', currency: 'KES' }), TenantValidationError);
  }
});

test('tenants: keeps only known channels and requires at least one', () => {
  const resolved = normalizeTenant({
    id: 'tenant-a',
    name: 'A',
    currency: 'KES',
    channels: ['WEB', 'WEB', 'CARRIER_PIGEON'],
  });
  assert.deepEqual(resolved.channels, ['WEB']);

  assert.throws(
    () => normalizeTenant({ id: 'tenant-a', name: 'A', currency: 'KES', channels: ['CARRIER_PIGEON'] }),
    TenantValidationError
  );
});
