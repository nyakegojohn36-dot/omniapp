import { createHash } from 'node:crypto';
import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Request, RequestHandler } from 'express';
import type {
  Order,
  Tenant,
  User,
  UserRole,
  WhatsAppCustomerSession,
  WhatsAppMessageRecord,
} from './types.ts';
import type { ReturnRequest } from './returns.ts';
import { CommerceStateUnavailableError } from './commerceState.ts';

export interface AuthenticatedUser extends User {
  emailVerified: boolean;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

const VALID_ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'BUSINESS_OWNER',
  'SALES_STAFF',
  'FULFILLMENT_STAFF',
  'SUPPORT_STAFF',
  'CUSTOMER',
];

let firebaseApp: App | undefined;

function getAdminApp(): App {
  if (firebaseApp) return firebaseApp;
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;
  firebaseApp = getApps()[0] || initializeApp({
    credential: applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });
  return firebaseApp;
}

export function getFirestoreDb(): Firestore {
  if (firestoreOverride) return firestoreOverride;
  return getFirestore(getAdminApp());
}

/**
 * Test seam for the record-store suite.
 *
 * A real Firestore cannot be made to fail quickly: gRPC retries an unreachable
 * endpoint for minutes rather than rejecting, so "the store is down" has to be
 * simulated. Production code never calls this; the tests install a database
 * whose reads and writes reject and then clear it again.
 */
let firestoreOverride: Firestore | null = null;

export function setFirestoreForTests(database: Firestore | null): void {
  firestoreOverride = database;
}

function documentId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The owner allowlist, read from configuration only.
 *
 * It used to be three addresses hardcoded here. A literal owner email in source
 * is a backdoor: anyone who can read the repository, or the bundle, knows an
 * address that self-provisions to BUSINESS_OWNER on first sign-in. It now comes
 * from OWNER_EMAILS (comma-separated) with OWNER_EMAIL kept for single-address
 * deployments that already have it set.
 */
function ownerAllowlist(): string[] {
  return (process.env.OWNER_EMAILS || process.env.OWNER_EMAIL || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function loadOrCreateUserProfile(
  decoded: {
    uid: string;
    email?: string;
    name?: string;
    email_verified?: boolean;
  }
): Promise<AuthenticatedUser> {
  const email = decoded.email?.trim().toLowerCase() || '';
  const tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic';

  const isConfiguredOwner = Boolean(email) && ownerAllowlist().includes(email);

  const fallbackProfile: AuthenticatedUser = {
    id: decoded.uid,
    email,
    name: decoded.name || email.split('@')[0] || 'User',
    tenantId,
    role: isConfiguredOwner ? 'BUSINESS_OWNER' : 'CUSTOMER',
    emailVerified: Boolean(decoded.email_verified),
  };

  const db = getFirestoreDb();
  const usersCollection = db.collection('users');
  const userRef = usersCollection.doc(decoded.uid);
  const profile = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const existing = snapshot.data();
    const emailMatch = snapshot.exists
      ? null
      : await transaction.get(usersCollection.where('email', '==', email).limit(1));
    const matchingDoc = emailMatch?.docs.find(
      (doc) => doc.data().tenantId === tenantId
    );
    const matchingProfile = matchingDoc?.data();
    const role = VALID_ROLES.find(
      (candidate) => candidate === (existing?.role || matchingProfile?.role)
    ) || fallbackProfile.role;
    const savedProfile: AuthenticatedUser = {
      ...fallbackProfile,
      name: decoded.name || existing?.name || matchingProfile?.name || fallbackProfile.name,
      tenantId: typeof existing?.tenantId === 'string'
        ? existing.tenantId
        : typeof matchingProfile?.tenantId === 'string'
        ? matchingProfile.tenantId
        : tenantId,
      role: isConfiguredOwner ? 'BUSINESS_OWNER' : role,
    };

    if (matchingDoc && matchingDoc.id !== userRef.id) {
      transaction.delete(matchingDoc.ref);
    }
    transaction.set(userRef, {
      id: savedProfile.id,
      email: savedProfile.email,
      name: savedProfile.name,
      tenantId: savedProfile.tenantId,
      role: savedProfile.role,
      updatedAt: new Date().toISOString(),
      ...(snapshot.exists ? {} : { createdAt: new Date().toISOString() }),
    }, { merge: true });

    return savedProfile;
  });

  return profile;
}

export const authenticateRequest: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  let firebaseAuth;
  try {
    firebaseAuth = getAuth(getAdminApp());
  } catch (error) {
    console.error('[Auth] Firebase Admin could not initialize. Check Cloud Run credentials and project ID.', error);
    res.status(503).json({ error: 'Authentication service is unavailable. Try again shortly.' });
    return;
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(match[1]);
  } catch {
    res.status(401).json({ error: 'The Firebase sign-in token is invalid or expired. Sign in again.' });
    return;
  }

  if (!decoded.email_verified && process.env.REQUIRE_EMAIL_VERIFIED === 'true') {
    res.status(403).json({ error: 'Verify your email address before accessing SokoFlow.' });
    return;
  }

  try {
    req.authUser = await loadOrCreateUserProfile(decoded);
    next();
  } catch (error) {
    console.error('[Auth] Could not load the Firebase user profile from Firestore.', error);
    res.status(503).json({ error: 'User profile storage is unavailable. Try again shortly.' });
  }
};

export function requireRoles(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.authUser || !roles.includes(req.authUser.role)) {
      res.status(403).json({ error: 'You do not have permission to perform this action.' });
      return;
    }
    next();
  };
}

export class WorkspaceProvisioningConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceProvisioningConflictError';
  }
}

/** Creates a tenant and makes its authenticated customer the initial owner atomically. */
export async function provisionTenantForOwner(tenant: Tenant, ownerId: string): Promise<User> {
  const db = getFirestoreDb();
  const users = db.collection('users');
  const userRef = users.doc(ownerId);
  const tenantRef = db.collection('tenants').doc(tenant.id);
  const now = new Date().toISOString();
  let owner: User | undefined;

  try {
    await db.runTransaction(async (transaction) => {
      const [userSnapshot, tenantSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(tenantRef),
      ]);
      const profile = userSnapshot.data() || {};
      if (
        userSnapshot.exists &&
        profile.role === 'BUSINESS_OWNER' &&
        profile.tenantId === tenant.id &&
        tenantSnapshot.exists
      ) {
        owner = {
          id: ownerId,
          tenantId: tenant.id,
          name: typeof profile.name === 'string' ? profile.name : 'Business Owner',
          email: typeof profile.email === 'string' ? profile.email : '',
          role: 'BUSINESS_OWNER',
        };
        return;
      }
      if (!userSnapshot.exists || userSnapshot.data()?.role !== 'CUSTOMER') {
        throw new WorkspaceProvisioningConflictError(
          'Only a customer account can create a new business workspace.'
        );
      }
      if (tenantSnapshot.exists) {
        throw new WorkspaceProvisioningConflictError('This workspace is already provisioned.');
      }

      owner = {
        id: ownerId,
        tenantId: tenant.id,
        name: typeof profile.name === 'string' ? profile.name : 'Business Owner',
        email: typeof profile.email === 'string' ? profile.email : '',
        role: 'BUSINESS_OWNER',
      };
      transaction.create(tenantRef, tenant);
      transaction.update(userRef, { tenantId: tenant.id, role: 'BUSINESS_OWNER', updatedAt: now });
    });
  } catch (error) {
    if (error instanceof WorkspaceProvisioningConflictError) throw error;
    throw new CommerceStateUnavailableError(
      'Business workspace storage is unavailable. Try again shortly.',
      error
    );
  }

  if (!owner) throw new Error('Workspace provisioning completed without an owner profile.');
  return owner;
}

export async function createTenantCustomer(
  tenantId: string,
  data: { name: string; email: string; role?: UserRole }
): Promise<User> {
  const email = data.email.trim().toLowerCase();
  const name = data.name.trim();
  const assignableRoles: UserRole[] = [
    'CUSTOMER',
    'SALES_STAFF',
    'FULFILLMENT_STAFF',
    'SUPPORT_STAFF',
  ];
  const role = data.role || 'CUSTOMER';
  if (!assignableRoles.includes(role)) {
    throw new Error('Only customer and staff roles may be assigned from the workspace.');
  }

  const db = getFirestoreDb();
  const usersCollection = db.collection('users');
  const userRef = usersCollection.doc();
  const now = new Date().toISOString();
  const newUser: User = { id: userRef.id, tenantId, name, email, role };

  await db.runTransaction(async (transaction) => {
    const matches = await transaction.get(
      usersCollection.where('email', '==', email).limit(1)
    );
    if (!matches.empty) {
      throw new Error('A customer or user with this email address already exists.');
    }
    transaction.create(userRef, {
      ...newUser,
      createdAt: now,
      updatedAt: now,
    });
  });

  return newUser;
}

export async function listTenantUsers(tenantId: string): Promise<User[]> {
  const list = new Map<string, User>();
  const snapshot = await getFirestoreDb()
    .collection('users')
    .where('tenantId', '==', tenantId)
    .get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    list.set(doc.id, {
      id: doc.id,
      tenantId: data.tenantId || tenantId,
      name: data.name,
      email: data.email,
      role: data.role,
    } as User);
  }

  return Array.from(list.values());
}

export async function updateTenantUserRole(
  tenantId: string,
  actorId: string,
  targetUserId: string,
  newRole: UserRole
): Promise<User | null> {
  if (!VALID_ROLES.includes(newRole) || newRole === 'BUSINESS_OWNER' || newRole === 'SUPER_ADMIN') {
    throw new Error('Only customer and staff roles may be assigned from the workspace.');
  }
  if (actorId === targetUserId) {
    throw new Error('You cannot change your own role.');
  }

  const db = getFirestoreDb();
  const targetRef = db.collection('users').doc(targetUserId);
  const target = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(targetRef);
    if (!snapshot.exists) return null;

    const data = snapshot.data()!;
    if (data.tenantId !== tenantId) return null;
    if (data.role === 'BUSINESS_OWNER' || data.role === 'SUPER_ADMIN') {
      throw new Error('Owner and administrator roles cannot be changed here.');
    }

    transaction.update(targetRef, {
      role: newRole,
      updatedAt: new Date().toISOString(),
    });

    return {
      id: snapshot.id,
      tenantId,
      name: typeof data.name === 'string' ? data.name : '',
      email: typeof data.email === 'string' ? data.email : '',
      role: newRole,
    } satisfies User;
  });

  return target;
}

const fallbackOrders = new Map<string, Order>();
const fallbackMessages = new Map<string, WhatsAppMessageRecord>();
const fallbackSessions = new Map<string, WhatsAppCustomerSession>();
const fallbackProcessedMessages = new Set<string>();

// ---------------------------------------------------------------------------
// Orders and returns
// ---------------------------------------------------------------------------

/**
 * Which store backs orders and returns.
 *
 * These helpers used to write to a process-local Map *and* attempt Firestore,
 * so a failed write still answered success while the order existed only in RAM.
 * An order is money, so the durable store now fails closed: a Firestore failure
 * becomes CommerceStateUnavailableError and the route answers 503.
 *
 * `memory` is chosen only by the same explicit COMMERCE_STATE_BACKEND=memory
 * opt-in that backs the stock runtime, and is for local development only.
 */
function recordStore(): 'memory' | 'firestore' {
  return (process.env.COMMERCE_STATE_BACKEND || '').trim().toLowerCase() === 'memory'
    ? 'memory'
    : 'firestore';
}

/** Runs a record operation, converting any failure into a 503-mapped error. */
async function durableRecord<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommerceStateUnavailableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CommerceStateUnavailableError(
      `Record store operation "${operation}" failed: ${message}`,
      error
    );
  }
}

export async function listTenantOrders(tenantId: string): Promise<Order[]> {
  if (recordStore() === 'memory') {
    return Array.from(fallbackOrders.values())
      .filter((order) => order.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return durableRecord('listTenantOrders', async () => {
    const snapshot = await getFirestoreDb()
      .collection('orders')
      .where('tenantId', '==', tenantId)
      .get();
    return snapshot.docs
      .map((doc) => doc.data() as Order)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export async function getTenantOrder(tenantId: string, orderId: string): Promise<Order | null> {
  if (recordStore() === 'memory') {
    return fallbackOrders.get(documentId(`${tenantId}:${orderId}`)) || null;
  }
  return durableRecord('getTenantOrder', async () => {
    const snapshot = await getFirestoreDb()
      .collection('orders')
      .doc(documentId(`${tenantId}:${orderId}`))
      .get();
    const order = snapshot.data() as Order | undefined;
    return order?.tenantId === tenantId ? order : null;
  });
}

export async function saveOrder(order: Order): Promise<void> {
  if (recordStore() === 'memory') {
    fallbackOrders.set(documentId(`${order.tenantId}:${order.id}`), order);
    return;
  }
  await durableRecord('saveOrder', () =>
    getFirestoreDb()
      .collection('orders')
      .doc(documentId(`${order.tenantId}:${order.id}`))
      .set(order, { merge: true })
  );
}

/**
 * Maps a Daraja CheckoutRequestID back to its order. Single-field equality, so
 * it needs no composite index; the tenant is read off the order itself because a
 * callback arrives with no caller identity at all.
 */
export async function findOrderByCheckoutRequestId(
  checkoutRequestId: string
): Promise<Order | null> {
  if (!checkoutRequestId) return null;
  if (recordStore() === 'memory') {
    for (const order of fallbackOrders.values()) {
      if (order.mpesaCheckoutRequestId === checkoutRequestId) return order;
    }
    return null;
  }
  return durableRecord('findOrderByCheckoutRequestId', async () => {
    const snapshot = await getFirestoreDb()
      .collection('orders')
      .where('mpesaCheckoutRequestId', '==', checkoutRequestId)
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    return doc ? (doc.data() as Order) : null;
  });
}

/**
 * Highest order number already present in a list of "ORD-000123" style ids.
 * Anchored on the trailing digit run so the year prefix cannot win.
 */
function highestOrderNumber(orderIds: string[]): number {
  let highest = 0;
  for (const id of orderIds) {
    const match = id.match(/(\d+)$/);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return highest;
}

/**
 * Allocates the next order number for a tenant.
 *
 * Order ids are human-facing, so they must never be reused. The counter lives in
 * Firestore and is incremented inside a transaction; on first use it is seeded
 * above every order already stored for the tenant. Unlike the other helpers in
 * this file it does not fall back to memory: a duplicate order number is worse
 * than a refused checkout.
 */
export async function nextOrderSequence(tenantId: string): Promise<number> {
  return durableRecord('nextOrderSequence', async () => {
    const db = getFirestoreDb();
    const counterRef = db.collection('counters').doc(documentId(`${tenantId}:orderSequence`));

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(counterRef);
      if (snapshot.exists) {
        const next = Number(snapshot.data()?.value ?? 0) + 1;
        transaction.update(counterRef, { value: next, updatedAt: new Date().toISOString() });
        return next;
      }

      // First allocation: seed above the existing numbers so nothing collides.
      const existing = await transaction.get(
        db.collection('orders').where('tenantId', '==', tenantId)
      );
      const next = highestOrderNumber(existing.docs.map((doc) => String(doc.data().id ?? ''))) + 1;
      transaction.create(counterRef, {
        tenantId,
        value: next,
        updatedAt: new Date().toISOString(),
      });
      return next;
    });
  });
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

const fallbackReturns = new Map<string, ReturnRequest>();

/**
 * Allocates the next return number for a tenant.
 *
 * Return ids are quoted to customers and printed on the warehouse paperwork, so
 * like order numbers they must never be reused. Firestore counter, no in-memory
 * fallback: a duplicate return number would let two claims collide on the same
 * refund.
 */
export async function nextReturnSequence(tenantId: string): Promise<number> {
  return durableRecord('nextReturnSequence', async () => {
    const db = getFirestoreDb();
    const counterRef = db.collection('counters').doc(documentId(`${tenantId}:returnSequence`));

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(counterRef);
      if (snapshot.exists) {
        const next = Number(snapshot.data()?.value ?? 0) + 1;
        transaction.update(counterRef, { value: next, updatedAt: new Date().toISOString() });
        return next;
      }

      const existing = await transaction.get(
        db.collection('returns').where('tenantId', '==', tenantId)
      );
      const next = highestOrderNumber(existing.docs.map((doc) => String(doc.data().id ?? ''))) + 1;
      transaction.create(counterRef, {
        tenantId,
        value: next,
        updatedAt: new Date().toISOString(),
      });
      return next;
    });
  });
}

export async function listTenantReturns(tenantId: string): Promise<ReturnRequest[]> {
  if (recordStore() === 'memory') {
    return Array.from(fallbackReturns.values())
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }
  return durableRecord('listTenantReturns', async () => {
    const snapshot = await getFirestoreDb()
      .collection('returns')
      .where('tenantId', '==', tenantId)
      .get();
    return snapshot.docs
      .map((doc) => doc.data() as ReturnRequest)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  });
}

export async function getTenantReturn(
  tenantId: string,
  returnId: string
): Promise<ReturnRequest | null> {
  if (recordStore() === 'memory') {
    return fallbackReturns.get(documentId(`${tenantId}:${returnId}`)) || null;
  }
  return durableRecord('getTenantReturn', async () => {
    const snapshot = await getFirestoreDb()
      .collection('returns')
      .doc(documentId(`${tenantId}:${returnId}`))
      .get();
    const record = snapshot.data() as ReturnRequest | undefined;
    return record?.tenantId === tenantId ? record : null;
  });
}

export async function saveReturnRequest(record: ReturnRequest): Promise<void> {
  if (recordStore() === 'memory') {
    fallbackReturns.set(documentId(`${record.tenantId}:${record.id}`), record);
    return;
  }
  await durableRecord('saveReturnRequest', () =>
    getFirestoreDb()
      .collection('returns')
      .doc(documentId(`${record.tenantId}:${record.id}`))
      .set(record, { merge: true })
  );
}

/**
 * The message log is a record of what was said, not a ledger. Reads fail closed
 * so an unreachable store shows as an error instead of an empty inbox. Writes
 * stay best-effort: the inbound message has already been processed, and failing
 * the webhook here would have Meta redeliver side effects that already happened.
 */
export async function listTenantMessages(tenantId: string): Promise<WhatsAppMessageRecord[]> {
  if (recordStore() === 'memory') {
    return Array.from(fallbackMessages.values())
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  return durableRecord('listTenantMessages', async () => {
    const snapshot = await getFirestoreDb()
      .collection('whatsappMessages')
      .where('tenantId', '==', tenantId)
      .get();
    return snapshot.docs
      .map((doc) => doc.data().message as WhatsAppMessageRecord)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  });
}

export async function saveWhatsAppMessages(
  tenantId: string,
  messages: WhatsAppMessageRecord[]
): Promise<void> {
  if (messages.length === 0) return;
  if (recordStore() === 'memory') {
    for (const message of messages) {
      fallbackMessages.set(message.id, message);
    }
    return;
  }
  try {
    const db = getFirestoreDb();
    for (let offset = 0; offset < messages.length; offset += 450) {
      const batch = db.batch();
      for (const message of messages.slice(offset, offset + 450)) {
        const ref = db.collection('whatsappMessages')
          .doc(documentId(`${tenantId}:${message.id}`));
        batch.set(ref, { tenantId, message }, { merge: true });
      }
      await batch.commit();
    }
  } catch (error) {
    console.error(
      `[WhatsApp] Could not persist ${messages.length} message(s) for tenant ${tenantId}. ` +
        'They will be missing from the inbox; the conversation itself was processed.',
      error
    );
  }
}

/**
 * Conversation state (the product being viewed, a cart in progress). Best-effort
 * on purpose: a customer repeating "1" costs a turn, while a webhook that 503s
 * costs a retry loop and duplicate replies. A lost session starts a fresh one.
 */
export async function getWhatsAppSession(
  phoneNumber: string,
  tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic'
): Promise<WhatsAppCustomerSession | null> {
  if (recordStore() === 'memory') {
    return fallbackSessions.get(documentId(`${tenantId}:${phoneNumber}`)) || null;
  }
  try {
    const snapshot = await getFirestoreDb()
      .collection('whatsappSessions')
      .doc(documentId(`${tenantId}:${phoneNumber}`))
      .get();
    return snapshot.data()?.session as WhatsAppCustomerSession | undefined || null;
  } catch (error) {
    console.warn('[WhatsApp] Session read failed; starting a fresh session:', (error as Error).message);
    return null;
  }
}

export async function saveWhatsAppSession(
  session: WhatsAppCustomerSession,
  tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic'
): Promise<void> {
  if (recordStore() === 'memory') {
    fallbackSessions.set(documentId(`${tenantId}:${session.phoneNumber}`), session);
    return;
  }
  try {
    await getFirestoreDb()
      .collection('whatsappSessions')
      .doc(documentId(`${tenantId}:${session.phoneNumber}`))
      .set({ tenantId, session });
  } catch (error) {
    console.warn(
      '[WhatsApp] Session write failed; the conversation will not remember this step:',
      (error as Error).message
    );
  }
}

export async function claimWebhookMessage(messageId: string): Promise<boolean> {
  const key = `${process.env.DEFAULT_TENANT_ID || 'tenant-nordic'}:${messageId}`;
  if (fallbackProcessedMessages.has(key)) return false;
  fallbackProcessedMessages.add(key);
  try {
    await getFirestoreDb()
      .collection('whatsappProcessedMessages')
      .doc(documentId(key))
      .create({ createdAt: new Date().toISOString() });
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 6 ||
        (error as { code?: number | string }).code === 'already-exists') {
      return false;
    }
    return true;
  }
}

export async function releaseWebhookMessage(messageId: string): Promise<void> {
  const key = `${process.env.DEFAULT_TENANT_ID || 'tenant-nordic'}:${messageId}`;
  fallbackProcessedMessages.delete(key);
  try {
    await getFirestoreDb()
      .collection('whatsappProcessedMessages')
      .doc(documentId(key))
      .delete();
  } catch {
    // Ignore cleanup errors
  }
}

export async function consumeWebChatQuota(userId: string, tenantId: string): Promise<boolean> {
  const db = getFirestoreDb();
  const quotaRef = db.collection('webChatRateLimits')
    .doc(documentId(`${tenantId}:${userId}`));
  const now = Date.now();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(quotaRef);
    const current = snapshot.data();
    const windowStartedAt = current?.windowStartedAt as number | undefined;
    const count = current?.count as number | undefined;
    if (!windowStartedAt || now - windowStartedAt >= 60_000) {
      transaction.set(quotaRef, { windowStartedAt: now, count: 1 });
      return true;
    }
    if ((count || 0) >= 20) return false;
    transaction.update(quotaRef, { count: (count || 0) + 1 });
    return true;
  });
}

export function getRequestUser(req: Request): AuthenticatedUser {
  if (!req.authUser) throw new Error('Authenticated user is missing from request.');
  return req.authUser;
}
