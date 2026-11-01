import { createHash } from 'node:crypto';
import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Request, RequestHandler } from 'express';
import type {
  Order,
  User,
  UserRole,
  WhatsAppCustomerSession,
  WhatsAppMessageRecord,
} from './types.ts';
import { SEED_CUSTOMER_PROFILES, SEED_USERS } from './sampleData.ts';

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

export function getFirestoreDb() {
  return getFirestore(getAdminApp());
}

function documentId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase() || '';
  const tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic';

  const isConfiguredOwner = Boolean(
    (ownerEmail && email && email === ownerEmail) ||
    email === 'nyakegojohn36@gmail.com' ||
    email === 'nyakegojohn7@gmail.com' ||
    email === 'alex@safaripeak.co.ke'
  );

  const fallbackProfile: AuthenticatedUser = {
    id: decoded.uid,
    email,
    name: decoded.name || email.split('@')[0] || 'User',
    tenantId,
    role: isConfiguredOwner ? 'BUSINESS_OWNER' : 'CUSTOMER',
    emailVerified: Boolean(decoded.email_verified),
  };

  try {
    const db = getFirestoreDb();
    const userRef = db.collection('users').doc(decoded.uid);
    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(userRef);
      const existing = snapshot.data();
      const role = VALID_ROLES.find((candidate) => candidate === existing?.role) || fallbackProfile.role;
      const profile: AuthenticatedUser = {
        ...fallbackProfile,
        name: decoded.name || existing?.name || fallbackProfile.name,
        tenantId: typeof existing?.tenantId === 'string' ? existing.tenantId : tenantId,
        role: isConfiguredOwner ? 'BUSINESS_OWNER' : role,
      };

      transaction.set(userRef, {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        tenantId: profile.tenantId,
        role: profile.role,
        updatedAt: new Date().toISOString(),
        ...(snapshot.exists ? {} : { createdAt: new Date().toISOString() }),
      }, { merge: true });

      return profile;
    });
  } catch (error) {
    console.warn('[Auth] Firestore storage unavailable, using verified profile:', (error as Error).message);
    return fallbackProfile;
  }
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

const inMemoryUserRegistry = new Map<string, User>();

function getInitialUserRegistry(): Map<string, User> {
  if (inMemoryUserRegistry.size > 0) return inMemoryUserRegistry;

  for (const u of SEED_USERS) {
    inMemoryUserRegistry.set(u.id, { ...u });
  }

  for (const c of SEED_CUSTOMER_PROFILES) {
    const existing = Array.from(inMemoryUserRegistry.values()).find((u) => u.email === c.email);
    if (!existing) {
      inMemoryUserRegistry.set(c.id, {
        id: c.id,
        tenantId: 'tenant-nordic',
        name: c.name,
        email: c.email,
        role: 'CUSTOMER',
      });
    }
  }

  return inMemoryUserRegistry;
}

export async function listTenantUsers(tenantId: string): Promise<User[]> {
  const registry = getInitialUserRegistry();
  const list = new Map<string, User>();

  for (const u of registry.values()) {
    list.set(u.id, { ...u, tenantId });
  }

  try {
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
  } catch (error) {
    console.warn('[Users] Firestore read unavailable, using memory registry:', (error as Error).message);
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

  const registry = getInitialUserRegistry();
  const target = registry.get(targetUserId) ||
    Array.from(registry.values()).find((u) => u.id === targetUserId);

  if (target) {
    if (target.role === 'BUSINESS_OWNER' || target.role === 'SUPER_ADMIN') {
      throw new Error('Owner and administrator roles cannot be changed here.');
    }
    target.role = newRole;
    target.tenantId = tenantId;
  }

  try {
    const db = getFirestoreDb();
    const targetRef = db.collection('users').doc(targetUserId);
    await targetRef.set({
      role: newRole,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (error) {
    console.warn('[Users] Firestore role update unavailable, updated in memory:', (error as Error).message);
  }

  if (target) return { ...target };
  return null;
}

const fallbackOrders = new Map<string, Order>();
const fallbackMessages = new Map<string, WhatsAppMessageRecord>();
const fallbackSessions = new Map<string, WhatsAppCustomerSession>();
const fallbackProcessedMessages = new Set<string>();

export async function listTenantOrders(tenantId: string): Promise<Order[]> {
  try {
    const snapshot = await getFirestoreDb()
      .collection('orders')
      .where('tenantId', '==', tenantId)
      .get();
    return snapshot.docs
      .map((doc) => doc.data() as Order)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    console.warn('[Orders] Firestore read unavailable, using memory store:', (error as Error).message);
    return Array.from(fallbackOrders.values())
      .filter((o) => o.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export async function getTenantOrder(tenantId: string, orderId: string): Promise<Order | null> {
  try {
    const snapshot = await getFirestoreDb()
      .collection('orders')
      .doc(documentId(`${tenantId}:${orderId}`))
      .get();
    const order = snapshot.data() as Order | undefined;
    return order?.tenantId === tenantId ? order : null;
  } catch {
    return fallbackOrders.get(documentId(`${tenantId}:${orderId}`)) || null;
  }
}

export async function saveOrder(order: Order): Promise<void> {
  fallbackOrders.set(documentId(`${order.tenantId}:${order.id}`), order);
  try {
    await getFirestoreDb()
      .collection('orders')
      .doc(documentId(`${order.tenantId}:${order.id}`))
      .set(order, { merge: true });
  } catch (error) {
    console.warn('[Orders] Firestore write unavailable, saved in memory:', (error as Error).message);
  }
}

export async function listTenantMessages(tenantId: string): Promise<WhatsAppMessageRecord[]> {
  try {
    const snapshot = await getFirestoreDb()
      .collection('whatsappMessages')
      .where('tenantId', '==', tenantId)
      .get();
    return snapshot.docs
      .map((doc) => doc.data().message as WhatsAppMessageRecord)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return Array.from(fallbackMessages.values())
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}

export async function saveWhatsAppMessages(
  tenantId: string,
  messages: WhatsAppMessageRecord[]
): Promise<void> {
  if (messages.length === 0) return;
  for (const m of messages) {
    fallbackMessages.set(m.id, m);
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
    console.warn('[WhatsApp] Firestore write unavailable, saved in memory:', (error as Error).message);
  }
}

export async function getWhatsAppSession(
  phoneNumber: string,
  tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic'
): Promise<WhatsAppCustomerSession | null> {
  try {
    const snapshot = await getFirestoreDb()
      .collection('whatsappSessions')
      .doc(documentId(`${tenantId}:${phoneNumber}`))
      .get();
    return snapshot.data()?.session as WhatsAppCustomerSession | undefined || null;
  } catch {
    return fallbackSessions.get(documentId(`${tenantId}:${phoneNumber}`)) || null;
  }
}

export async function saveWhatsAppSession(
  session: WhatsAppCustomerSession,
  tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic'
): Promise<void> {
  fallbackSessions.set(documentId(`${tenantId}:${session.phoneNumber}`), session);
  try {
    await getFirestoreDb()
      .collection('whatsappSessions')
      .doc(documentId(`${tenantId}:${session.phoneNumber}`))
      .set({ tenantId, session });
  } catch (error) {
    console.warn('[WhatsApp] Firestore session write unavailable, saved in memory:', (error as Error).message);
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
