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
  const db = getFirestoreDb();
  const userRef = db.collection('users').doc(decoded.uid);
  const email = decoded.email?.trim().toLowerCase() || '';
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase() || '';
  const tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic';

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const existing = snapshot.data();
    const role = VALID_ROLES.find((candidate) => candidate === existing?.role) || 'CUSTOMER';
    const isConfiguredOwner = Boolean(
      ownerEmail && email && email === ownerEmail && decoded.email_verified
    );
    const profile: AuthenticatedUser = {
      id: decoded.uid,
      email,
      name: decoded.name || existing?.name || email,
      tenantId: typeof existing?.tenantId === 'string' ? existing.tenantId : tenantId,
      role: isConfiguredOwner ? 'BUSINESS_OWNER' : decoded.email_verified ? role : 'CUSTOMER',
      emailVerified: Boolean(decoded.email_verified),
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

  if (!decoded.email_verified) {
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

export async function listTenantUsers(tenantId: string): Promise<User[]> {
  const snapshot = await getFirestoreDb()
    .collection('users')
    .where('tenantId', '==', tenantId)
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      tenantId: data.tenantId,
      name: data.name,
      email: data.email,
      role: data.role,
    } as User;
  });
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
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(targetRef);
    if (!snapshot.exists || snapshot.data()?.tenantId !== tenantId) return null;
    const target = snapshot.data()!;
    if (target.role === 'BUSINESS_OWNER' || target.role === 'SUPER_ADMIN') {
      throw new Error('Owner and administrator roles cannot be changed here.');
    }
    transaction.update(targetRef, {
      role: newRole,
      updatedAt: new Date().toISOString(),
    });
    return {
      id: snapshot.id,
      tenantId,
      name: target.name,
      email: target.email,
      role: newRole,
    } as User;
  });
}

export async function listTenantOrders(tenantId: string): Promise<Order[]> {
  const snapshot = await getFirestoreDb()
    .collection('orders')
    .where('tenantId', '==', tenantId)
    .get();
  return snapshot.docs
    .map((doc) => doc.data() as Order)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTenantOrder(tenantId: string, orderId: string): Promise<Order | null> {
  const snapshot = await getFirestoreDb()
    .collection('orders')
    .doc(documentId(`${tenantId}:${orderId}`))
    .get();
  const order = snapshot.data() as Order | undefined;
  return order?.tenantId === tenantId ? order : null;
}

export async function saveOrder(order: Order): Promise<void> {
  await getFirestoreDb()
    .collection('orders')
    .doc(documentId(`${order.tenantId}:${order.id}`))
    .set(order, { merge: true });
}

export async function listTenantMessages(tenantId: string): Promise<WhatsAppMessageRecord[]> {
  const snapshot = await getFirestoreDb()
    .collection('whatsappMessages')
    .where('tenantId', '==', tenantId)
    .get();
  return snapshot.docs
    .map((doc) => doc.data().message as WhatsAppMessageRecord)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function saveWhatsAppMessages(
  tenantId: string,
  messages: WhatsAppMessageRecord[]
): Promise<void> {
  if (messages.length === 0) return;
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
}

export async function getWhatsAppSession(
  phoneNumber: string,
  tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic'
): Promise<WhatsAppCustomerSession | null> {
  const snapshot = await getFirestoreDb()
    .collection('whatsappSessions')
    .doc(documentId(`${tenantId}:${phoneNumber}`))
    .get();
  return snapshot.data()?.session as WhatsAppCustomerSession | undefined || null;
}

export async function saveWhatsAppSession(
  session: WhatsAppCustomerSession,
  tenantId = process.env.DEFAULT_TENANT_ID || 'tenant-nordic'
): Promise<void> {
  await getFirestoreDb()
    .collection('whatsappSessions')
    .doc(documentId(`${tenantId}:${session.phoneNumber}`))
    .set({ tenantId, session });
}

export async function claimWebhookMessage(messageId: string): Promise<boolean> {
  try {
    await getFirestoreDb()
      .collection('whatsappProcessedMessages')
      .doc(documentId(`${process.env.DEFAULT_TENANT_ID || 'tenant-nordic'}:${messageId}`))
      .create({ createdAt: new Date().toISOString() });
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 6 ||
        (error as { code?: number | string }).code === 'already-exists') {
      return false;
    }
    throw error;
  }
}

export async function releaseWebhookMessage(messageId: string): Promise<void> {
  await getFirestoreDb()
    .collection('whatsappProcessedMessages')
    .doc(documentId(`${process.env.DEFAULT_TENANT_ID || 'tenant-nordic'}:${messageId}`))
    .delete();
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
