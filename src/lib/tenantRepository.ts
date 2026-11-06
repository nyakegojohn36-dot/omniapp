/**
 * Tenant records as data, not source code.
 *
 * Everything priced, taxed, or reserved in this app is scoped to a tenant, and
 * those rules (currency, VAT rate, inclusive/exclusive, reservation TTL) used to
 * live in `SEED_TENANTS`. That made onboarding a customer a redeploy, and it
 * made `tenantFor()` able to fall back to somebody else's tax configuration for
 * an unknown id.
 *
 * Tenants now live in the `tenants` collection, validated on the way in. A
 * missing tenant is an error, never a default: pricing an order against a
 * guessed tenant is worse than refusing the request.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getFirestoreDb } from './firebaseAdmin.ts';
import type { Tenant } from './types.ts';

const TENANTS = 'tenants';
const DEFAULT_CACHE_TTL_MS = 60_000;

export const TENANT_CHANNELS: Tenant['channels'][number][] = [
  'WEB',
  'WHATSAPP',
  'SHOPIFY_SYNC',
  'MARKETPLACE',
];

/** Thrown for caller mistakes (400), distinguishable from store failures (503). */
export class TenantValidationError extends Error {
  field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'TenantValidationError';
    this.field = field;
  }
}

/** Thrown when a token references a tenant that does not exist (404). */
export class UnknownTenantError extends Error {
  tenantId: string;

  constructor(tenantId: string) {
    super(`No tenant is registered under "${tenantId}".`);
    this.name = 'UnknownTenantError';
    this.tenantId = tenantId;
  }
}

export interface TenantRepository {
  get(tenantId: string): Promise<Tenant | null>;
  /** Throws UnknownTenantError so callers cannot silently price against a default. */
  require(tenantId: string): Promise<Tenant>;
  list(): Promise<Tenant[]>;
  create(input: unknown): Promise<Tenant>;
  update(tenantId: string, patch: unknown): Promise<Tenant>;
  /** Writes tenants only when the collection is empty. Returns true if it wrote. */
  seedIfEmpty(tenants: Tenant[]): Promise<boolean>;
  /** Drops cached records after a write, so the next read sees it. */
  invalidate(tenantId?: string): void;
}

function readString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TenantValidationError(field, `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new TenantValidationError(field, `${field} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new TenantValidationError(field, `${field} must be true or false.`);
  }
  return value;
}

function readNumberInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
  integer = false
): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TenantValidationError(field, `${field} must be a number.`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new TenantValidationError(field, `${field} must be a whole number.`);
  }
  if (parsed < min || parsed > max) {
    throw new TenantValidationError(field, `${field} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function readChannels(value: unknown, fallback: Tenant['channels']): Tenant['channels'] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new TenantValidationError('channels', 'channels must be a list.');
  }
  const channels = value.filter((candidate): candidate is Tenant['channels'][number] =>
    TENANT_CHANNELS.includes(candidate as Tenant['channels'][number])
  );
  const unique = [...new Set(channels)];
  if (unique.length === 0) {
    throw new TenantValidationError(
      'channels',
      `channels must contain at least one of: ${TENANT_CHANNELS.join(', ')}.`
    );
  }
  return unique;
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Validates a tenant document. `existing` supplies fallbacks on update so a
 * partial patch cannot blank out a required setting.
 */
export function normalizeTenant(input: unknown, existing?: Tenant): Tenant {
  if (typeof input !== 'object' || input === null) {
    throw new TenantValidationError('tenant', 'A tenant object is required.');
  }
  const raw = input as Record<string, unknown>;

  const id = existing?.id ?? String(raw.id ?? '').trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(id)) {
    throw new TenantValidationError(
      'id',
      'id must be 2-63 characters of lowercase letters, digits, or hyphens.'
    );
  }

  const slugRaw = raw.slug === undefined ? existing?.slug ?? id : String(raw.slug).trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(slugRaw)) {
    throw new TenantValidationError('slug', 'slug must be lowercase letters, digits, or hyphens.');
  }

  const currency = readString(raw.currency ?? existing?.currency, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TenantValidationError('currency', 'currency must be a 3-letter ISO code, e.g. KES.');
  }

  return {
    id,
    name: readString(raw.name ?? existing?.name, 'name', 80),
    slug: slugRaw,
    currency,
    locale: readString(raw.locale ?? existing?.locale ?? 'en-KE', 'locale', 20),
    timezone: readString(raw.timezone ?? existing?.timezone ?? 'Africa/Nairobi', 'timezone', 64),
    // 0-100 rather than 0-1: the pricing engine already speaks percent.
    taxRatePercent: readNumberInRange(
      raw.taxRatePercent ?? existing?.taxRatePercent,
      'taxRatePercent',
      0,
      100,
      existing?.taxRatePercent ?? 0
    ),
    taxInclusive: readBoolean(raw.taxInclusive, 'taxInclusive', existing?.taxInclusive ?? true),
    reservationTTLMinutes: readNumberInRange(
      raw.reservationTTLMinutes ?? existing?.reservationTTLMinutes,
      'reservationTTLMinutes',
      1,
      240,
      existing?.reservationTTLMinutes ?? 15,
      true
    ),
    channels: readChannels(raw.channels, existing?.channels ?? ['WEB', 'WHATSAPP']),
  };
}

/** Firestore rejects undefined values, so every key is written explicitly. */
function toDocument(tenant: Tenant): Record<string, unknown> {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    currency: tenant.currency,
    locale: tenant.locale,
    timezone: tenant.timezone,
    taxRatePercent: tenant.taxRatePercent,
    taxInclusive: tenant.taxInclusive,
    reservationTTLMinutes: tenant.reservationTTLMinutes,
    channels: tenant.channels,
  };
}

function fromDocument(data: Record<string, unknown> | undefined, fallbackId: string): Tenant {
  const raw = data ?? {};
  // Reuse the validator so a hand-edited document cannot smuggle in a bad rate.
  return normalizeTenant({ ...raw, id: String(raw.id ?? fallbackId) });
}

export class InMemoryTenantRepository implements TenantRepository {
  private tenants = new Map<string, Tenant>();

  constructor(seed: Tenant[] = []) {
    for (const tenant of seed) this.tenants.set(tenant.id, tenant);
  }

  async get(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async require(tenantId: string): Promise<Tenant> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new UnknownTenantError(tenantId);
    return tenant;
  }

  async list(): Promise<Tenant[]> {
    return [...this.tenants.values()];
  }

  async create(input: unknown): Promise<Tenant> {
    const tenant = normalizeTenant(input);
    if (this.tenants.has(tenant.id)) {
      throw new TenantValidationError('id', `Tenant "${tenant.id}" already exists.`);
    }
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async update(tenantId: string, patch: unknown): Promise<Tenant> {
    const existing = await this.require(tenantId);
    const updated = normalizeTenant(patch, existing);
    this.tenants.set(updated.id, updated);
    return updated;
  }

  async seedIfEmpty(seed: Tenant[]): Promise<boolean> {
    if (this.tenants.size > 0) return false;
    for (const tenant of seed) this.tenants.set(tenant.id, tenant);
    return seed.length > 0;
  }

  invalidate(): void {
    // Nothing cached.
  }
}

/**
 * Reads are cached briefly because every request needs the tenant's tax and TTL
 * settings, and those change on the order of weeks. Writes drop the cache.
 */
export class FirestoreTenantRepository implements TenantRepository {
  private db: Firestore;
  private cache = new Map<string, { tenant: Tenant; expiresAt: number }>();
  private cacheTtlMs: number;
  private collectionName: string;

  constructor(
    db: Firestore = getFirestoreDb(),
    cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
    // Overridable so a test can point at its own collection. Seeding asks
    // "is this collection empty?", which cannot be exercised in isolation on the
    // shared one.
    collectionName: string = TENANTS
  ) {
    this.db = db;
    this.cacheTtlMs = cacheTtlMs;
    this.collectionName = collectionName;
  }

  private collection() {
    return this.db.collection(this.collectionName);
  }

  invalidate(tenantId?: string): void {
    if (tenantId) {
      this.cache.delete(tenantId);
      return;
    }
    this.cache.clear();
  }

  async get(tenantId: string): Promise<Tenant | null> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;

    const snapshot = await this.collection().doc(tenantId).get();
    if (!snapshot.exists) {
      this.cache.delete(tenantId);
      return null;
    }
    const tenant = fromDocument(snapshot.data(), tenantId);
    this.cache.set(tenantId, { tenant, expiresAt: Date.now() + this.cacheTtlMs });
    return tenant;
  }

  async require(tenantId: string): Promise<Tenant> {
    const tenant = await this.get(tenantId);
    if (!tenant) throw new UnknownTenantError(tenantId);
    return tenant;
  }

  async list(): Promise<Tenant[]> {
    const snapshot = await this.collection().get();
    return snapshot.docs.map((doc) => fromDocument(doc.data(), doc.id));
  }

  async create(input: unknown): Promise<Tenant> {
    const tenant = normalizeTenant(input);
    const ref = this.collection().doc(tenant.id);
    const created = await this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        throw new TenantValidationError('id', `Tenant "${tenant.id}" already exists.`);
      }
      transaction.create(ref, { ...toDocument(tenant), createdAt: new Date().toISOString() });
      return tenant;
    });
    this.invalidate(tenant.id);
    return created;
  }

  async update(tenantId: string, patch: unknown): Promise<Tenant> {
    const existing = await this.require(tenantId);
    const updated = normalizeTenant(patch, existing);
    await this.collection()
      .doc(tenantId)
      .set({ ...toDocument(updated), updatedAt: new Date().toISOString() }, { merge: true });
    this.invalidate(tenantId);
    return updated;
  }

  async seedIfEmpty(seed: Tenant[]): Promise<boolean> {
    const snapshot = await this.collection().limit(1).get();
    if (!snapshot.empty) return false;

    const batch = this.db.batch();
    for (const tenant of seed) {
      batch.set(this.collection().doc(tenant.id), {
        ...toDocument(tenant),
        createdAt: new Date().toISOString(),
      });
    }
    await batch.commit();
    this.invalidate();
    return seed.length > 0;
  }
}

export function createTenantRepository(options?: {
  backend?: 'firestore' | 'memory';
  seed?: Tenant[];
}): TenantRepository {
  const configured = (options?.backend ?? process.env.COMMERCE_STATE_BACKEND ?? '')
    .trim()
    .toLowerCase();
  if (configured === 'memory') {
    return new InMemoryTenantRepository(options?.seed ?? []);
  }
  return new FirestoreTenantRepository();
}
