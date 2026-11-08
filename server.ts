import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { WhatsAppCloudService } from './src/lib/whatsappCloudService.ts';
import { ASSISTANT_ROLES, AssistantError, createGeminiAssistant, readGeminiConfig } from './src/lib/geminiAssistant.ts';
import { createCommerceRuntime } from './src/lib/commerceRuntime.ts';
import { CommerceStateUnavailableError } from './src/lib/firestoreCommerceState.ts';
import { createOrderFromIntake } from './src/lib/orderIntake.ts';
import {
  amountKesFromCents,
  createDarajaClient,
  MpesaRequestError,
  normalizeKenyanPhone,
  readMpesaConfig,
  type MpesaConfig,
} from './src/lib/mpesaDaraja.ts';
import { applyStkOutcome, handleStkCallback, simulateSettlement } from './src/lib/mpesaSettlement.ts';
import {
  createTenantRepository,
  normalizeTenant,
  TenantValidationError,
  UnknownTenantError,
} from './src/lib/tenantRepository.ts';
import { transitionOrder } from './src/lib/orderStateMachine.ts';
import {
  createReturnRequest,
  inspectReturn,
  markRefundPaid,
  receiveReturn,
  type ReturnReason,
  type ReturnRequest,
  type ReturnStatus,
} from './src/lib/returns.ts';
import {
  SEED_INVENTORIES,
  SEED_PRODUCTS,
  SEED_TENANTS,
} from './src/lib/sampleData.ts';
import { availabilityBySku, type AdjustStockCommand } from './src/lib/commerceState.ts';
import type { Order, OrderAddress, OrderStatus, Product, Tenant, WarehouseInventory } from './src/lib/types.ts';
import {
  authenticateRequest,
  canManageSharedWhatsApp,
  getPendingBusinessWorkspace,
  savePendingBusinessWorkspace,
  sharedWhatsAppAccessPolicy,
  claimWebhookMessage,
  consumeWebChatQuota,
  getRequestUser,
  getTenantOrder,
  getTenantReturn,
  getWhatsAppSession,
  findOrderByCheckoutRequestId,
  listTenantMessages,
  listTenantOrders,
  listTenantReturns,
  createTenantCustomer,
  provisionTenantForOwner,
  WorkspaceProvisioningConflictError,
  listTenantUsers,
  nextOrderSequence,
  nextReturnSequence,
  releaseWebhookMessage,
  requireRoles,
  saveOrder,
  saveReturnRequest,
  saveWhatsAppMessages,
  saveWhatsAppSession,
  updateTenantUserRole,
} from './src/lib/firebaseAdmin.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
function getPort(): number {
  const portArgIdx = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const parsed = Number(process.argv[portArgIdx + 1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  if (process.env.NODE_ENV !== 'production') {
    return 3000;
  }
  return Number(process.env.PORT) || 3000;
}

const PORT = getPort();
const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || (process.env.NODE_ENV === 'production'
    ? ''
    : 'http://localhost:3000,http://localhost:5173'))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use((req: Request, res: Response, next) => {
  const origin = req.header('origin');
  if (!origin) return next();

  const host = req.header('host');
  const isSameHost = Boolean(host && (origin === `http://${host}` || origin === `https://${host}`));
  const isAllowedOrigin =
    allowedOrigins.has(origin) ||
    isSameHost ||
    origin.endsWith('.run.app') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1');

  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  } else if (req.path.startsWith('/api/') && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'This frontend origin is not allowed.' });
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

app.set('trust proxy', 1);

// Commerce source of truth. Stock, reservations, and the catalogue are durable;
// no part of this process keeps an authoritative copy any more.
const commerce = createCommerceRuntime();
const geminiConfig = readGeminiConfig();
const assistant = createGeminiAssistant(geminiConfig, {
  consumeQuota: (userId, scopedTenantId) => consumeWebChatQuota(`assistant-${userId}`, scopedTenantId),
  readContext: async (scopedTenantId) => {
    const [tenant, products, orders, stock] = await Promise.all([
      tenants.require(scopedTenantId),
      commerce.state.listProducts(scopedTenantId),
      listTenantOrders(scopedTenantId),
      commerce.conversationStock(scopedTenantId),
    ]);
    return { tenant, products, orders, stock };
  },
});
// Tenant rules (currency, VAT, reservation TTL) are data. The public webhook has
// no caller identity, so it alone uses this configured default tenant.
const tenants = createTenantRepository({ seed: SEED_TENANTS });
const tenantId = process.env.DEFAULT_TENANT_ID || SEED_TENANTS[0].id;
// The reference catalogue is demo stock. Local and preview environments keep it so
// the app is usable out of the box; production sets this to false so real
// workspaces start empty instead of selling products the business does not have.
const seedReferenceCatalogue = process.env.SEED_REFERENCE_CATALOGUE?.trim().toLowerCase() !== 'false';

// Read once at boot: /health reports it, and checkout refuses rather than guesses
// when the Daraja credentials are absent.
const mpesaConfig: MpesaConfig | null = readMpesaConfig();
if (!mpesaConfig) {
  console.warn(
    '[M-Pesa] Daraja credentials are not set, so STK push is disabled and the API ' +
    'returns 503 rather than simulating a payment.'
  );
} else if (mpesaConfig.environment === 'sandbox') {
  console.info('[M-Pesa] Daraja client in sandbox mode.');
}

/**
 * The parcel is still ours to redirect only until it is handed to a courier.
 * Editing a delivery address after dispatch would point the goods somewhere the
 * courier never agreed to take them.
 */
const ADDRESS_EDITABLE_STATUSES: OrderStatus[] = [
  'DRAFT',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
];

/**
 * Merges an address patch onto the one on file. Every required field must still
 * be present afterwards: a half-applied delivery address is worse than a refused
 * edit, because the courier would be sent somewhere that does not exist.
 */
function normalizeAddressPatch(
  input: unknown,
  existing: OrderAddress
): { ok: true; value: OrderAddress } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'shippingAddress must be an object.' };
  }

  const raw = input as Record<string, unknown>;
  const addressKeys: (keyof OrderAddress)[] = [
    'fullName',
    'addressLine1',
    'addressLine2',
    'city',
    'stateOrProvince',
    'postalCode',
    'countryCode',
    'phone',
  ];

  const merged: Record<string, string> = {};
  for (const key of addressKeys) {
    const incoming = raw[key];
    if (incoming === undefined) {
      merged[key] = existing[key] ?? '';
      continue;
    }
    if (typeof incoming !== 'string') {
      return { ok: false, error: `shippingAddress.${key} must be a string.` };
    }
    merged[key] = incoming.trim();
  }

  for (const required of [
    'fullName',
    'addressLine1',
    'city',
    'postalCode',
    'countryCode',
    'phone',
  ] as const) {
    if (!merged[required]) {
      return { ok: false, error: `shippingAddress.${required} cannot be empty.` };
    }
  }

  const countryCode = merged.countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return {
      ok: false,
      error: 'shippingAddress.countryCode must be a two-letter ISO code, e.g. KE.',
    };
  }

  return {
    ok: true,
    value: {
      fullName: merged.fullName,
      addressLine1: merged.addressLine1,
      ...(merged.addressLine2 ? { addressLine2: merged.addressLine2 } : {}),
      city: merged.city,
      ...(merged.stateOrProvince ? { stateOrProvince: merged.stateOrProvince } : {}),
      postalCode: merged.postalCode,
      countryCode,
      phone: merged.phone,
    } satisfies OrderAddress,
  };
}

/**
 * Keeps stock in step with the order lifecycle. Confirming an order commits its
 * reservations, so the units leave the warehouse; cancelling releases them back
 * into availability. Both operations are idempotent, so a replay cannot
 * double-count a reservation.
 */
async function reconcileReservations(scopedTenantId: string, order: Order): Promise<void> {
  if (order.status !== 'CONFIRMED' && order.status !== 'CANCELLED') return;

  const reservations = await commerce.state.listReservations(scopedTenantId, {
    orderId: order.id,
  });
  for (const reservation of reservations) {
    if (reservation.status !== 'ACTIVE') continue;
    if (order.status === 'CONFIRMED') {
      await commerce.state.commit(scopedTenantId, reservation.id);
    } else {
      await commerce.state.cancel(scopedTenantId, reservation.id);
    }
  }
}

/**
 * Writes the reference tenants on first boot and reports a misconfigured
 * DEFAULT_TENANT_ID. Seeding is idempotent, so it is safe on every start.
 */
async function bootstrapTenants(): Promise<void> {
  try {
    if (await tenants.seedIfEmpty(SEED_TENANTS)) {
      console.info(`[Tenant] Seeded ${SEED_TENANTS.length} tenant record(s).`);
    }
    // This used to fall back silently to tenant one. Now it is loud, because the
    // WhatsApp webhook has no caller identity to derive a tenant from.
    if (!await tenants.get(tenantId)) {
      console.error(
        `[Tenant] DEFAULT_TENANT_ID "${tenantId}" is not registered. ` +
        'The WhatsApp webhook will reject messages until it exists.'
      );
    }
  } catch (error) {
    // Bootstrap must not stop the process: /health still needs to answer so the
    // platform can report the fault. Tenant-dependent routes fail closed.
    console.error(
      '[Tenant] Bootstrap failed:',
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Expired reservations are already subtracted at read time, so availability is
 * never stale. This sweeper exists so the persisted `reservedStock` does not
 * drift forever and read-time work stays proportional to real demand.
 *
 * Disabled with COMMERCE_SWEEP_INTERVAL_SECONDS=0.
 */
function startReservationSweeper(scopedTenantId: string): NodeJS.Timeout | null {
  const configured = Number(process.env.COMMERCE_SWEEP_INTERVAL_SECONDS ?? 60);
  if (!Number.isFinite(configured) || configured <= 0) {
    console.info('[Commerce] Reservation sweeper disabled.');
    return null;
  }
  const intervalMs = Math.max(10, configured) * 1000;

  const sweep = async () => {
    try {
      const released = await commerce.state.releaseExpired(scopedTenantId);
      if (released > 0) {
        console.info(`[Commerce] Sweeper released ${released} expired reservation(s).`);
      }
    } catch (error) {
      // A failed sweep must never take the process down; the next tick retries.
      console.error(
        '[Commerce] Reservation sweep failed:',
        error instanceof Error ? error.message : error
      );
    }
  };

  const handle = setInterval(() => void sweep(), intervalMs);
  handle.unref();
  console.info(`[Commerce] Reservation sweeper every ${intervalMs / 1000}s.`);
  return handle;
}

/**
 * Coarse request throttle.
 *
 * Deliberately mounted before authentication: verifying a Firebase ID token is a
 * network round trip, so the unauthenticated path is the expensive one to flood.
 * That also means the counter can only be keyed by address, not by user - staff
 * sharing one office NAT share a bucket, which is why the default is generous.
 *
 * This is not a distributed limiter: each instance keeps its own counters, so it
 * bounds one client's burst rather than guaranteeing a global rate. Put a real
 * limiter in front of the service if you need that guarantee.
 */
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) > 0
  ? Number(process.env.RATE_LIMIT_WINDOW_MS)
  : 60_000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) > 0
  ? Number(process.env.RATE_LIMIT_MAX_REQUESTS)
  : 600;

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const rateLimitSweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS);
rateLimitSweeper.unref();

app.use('/api', (req: Request, res: Response, next) => {
  // Safaricom retries a callback until it gets an answer. Throttling it would
  // turn a rate limiter into a payment delay, and the settlement path is already
  // idempotent.
  if (req.path.toLowerCase() === '/payments/mpesa/callback' && req.method === 'POST') {
    next();
    return;
  }

  const key = req.ip || 'unknown';
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    res.status(429).json({ error: 'Too many requests. Please slow down and retry shortly.' });
    return;
  }

  next();
});

app.use('/api', (req: Request, res: Response, next) => {
  const requestPath = req.path.toLowerCase();
  const publicWebhook =
    ((requestPath === '/whatsapp/webhook' || requestPath === '/webhooks/whatsapp') &&
      (req.method === 'GET' || req.method === 'POST')) ||
    // Daraja posts the settlement callback with no caller identity, so it is
    // authenticated by matching the CheckoutRequestID to an order we issued it
    // for - never by trusting the payload itself.
    (requestPath === '/payments/mpesa/callback' && req.method === 'POST');
  if (publicWebhook) return next();
  return authenticateRequest(req, res, next);
});

const asyncRoute = (
  handler: (req: Request, res: Response) => Promise<void>
): RequestHandler => (req, res, next) => {
  void handler(req, res).catch((error) => {
    if (sendKnownError(res, error)) return;
    next(error);
  });
};

/**
 * Turning known failures into their real status codes:
 *  - authoritative store unreachable -> 503 (retryable, never guessed at)
 *  - token references a tenant that does not exist -> 404 (never a default)
 *  - tenant payload is invalid -> 400 with the offending field
 * Anything else keeps falling through to the generic handler.
 */
function sendKnownError(res: Response, error: unknown): boolean {
  if (error instanceof CommerceStateUnavailableError) {
    console.error('[Commerce] Authoritative store unavailable.', error.originalError ?? error);
    res.status(503).json({
      error: 'Inventory and reservations are temporarily unavailable. Please retry in a moment.',
    });
    return true;
  }
  if (error instanceof UnknownTenantError) {
    console.error('[Tenant] Unknown tenant on request:', error.tenantId);
    res.status(404).json({ error: 'No workspace is configured for this account.' });
    return true;
  }
  if (error instanceof TenantValidationError) {
    res.status(400).json({ error: error.message, field: error.field });
    return true;
  }
  return false;
}

/**
 * Historical name for the same wrapper: routes touching the authoritative store
 * were once the only ones allowed to surface a 503. Every route now maps known
 * failures identically, so this is an alias rather than a second policy.
 */
const commerceRoute = asyncRoute;
const initialToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
const initialAppSecret = process.env.WHATSAPP_APP_SECRET || '';
const initialPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const initialWabaId = process.env.WHATSAPP_WABA_ID || '';
const initialDisplayPhone = process.env.WHATSAPP_DISPLAY_PHONE || 'Meta Developer Sandbox';
const initialVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
const initialMode = (process.env.WHATSAPP_OPERATING_MODE as any) || 'SIMULATED_DEMO';

const whatsappService = new WhatsAppCloudService(
  {
    mode: initialMode,
    phoneNumberId: initialPhoneNumberId,
    wabaId: initialWabaId,
    displayPhoneNumber: initialDisplayPhone,
    verifyToken: initialVerifyToken,
    authorizedTestRecipient: '',
  },
  initialToken,
  initialAppSecret
);
whatsappService.setMessagePersistenceHandler((message) =>
  saveWhatsAppMessages(tenantId, [message])
);

// 1. Meta WhatsApp Webhook Handshake Verification (GET)
app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const verification = whatsappService.verifyWebhook(query);

  if (verification.verified) {
    // Meta requires the challenge number returned as plain text with HTTP 200
    res.status(200).type('text/plain').send(verification.challenge);
  } else {
    res.status(403).json({ error: verification.error || 'Verification failed' });
  }
});

// Alias for backwards-compatibility
app.get('/api/webhooks/whatsapp', (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const verification = whatsappService.verifyWebhook(query);
  if (verification.verified) {
    res.status(200).type('text/plain').send(verification.challenge);
  } else {
    res.status(403).json({ error: verification.error || 'Verification failed' });
  }
});

// 2. Meta WhatsApp Inbound Webhook Event Receiver (POST)
const handleInboundWebhook = async (req: Request, res: Response) => {
  console.info('[Meta Webhook] POST received.');
  let claimedMessageId: string | undefined;
  try {
    // Verify HMAC-SHA256 signatures for every webhook mode.
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const sigVerification = whatsappService.verifySignature((req as any).rawBody, sigHeader);
    if (!sigVerification.valid) {
      console.warn(`[Meta Webhook] Signature verification failed: ${sigVerification.reason}`);
      return res.status(401).json({ error: `Unauthorized: ${sigVerification.reason}` });
    }

    const payload = req.body;
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    const contact = change?.contacts?.[0];

    // Handle delivery status update events (e.g. delivered, read, failed)
    const statuses = change?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      const persistedMessages = await listTenantMessages(tenantId);
      let messagesChanged = false;
      for (const st of statuses) {
        const wamid = st.id;
        const status = st.status?.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
        const errorDetail = st.errors?.[0]?.message || st.errors?.[0]?.title;
        if (wamid && status) {
          whatsappService.updateMessageStatus(wamid, status, errorDetail);
          const persisted = persistedMessages.find((item) => item.wamid === wamid);
          if (persisted) {
            persisted.status = status;
            if (errorDetail) persisted.errorMessage = errorDetail;
            messagesChanged = true;
          }
        }
      }
      if (messagesChanged) await saveWhatsAppMessages(tenantId, persistedMessages);
      console.info(`[Meta Webhook] Acknowledged ${statuses.length} message status update(s).`);
      return res.status(200).json({ status: 'STATUSES_ACKNOWLEDGED', count: statuses.length });
    }

    if (!message) {
      // Return 200 to acknowledge Meta webhook test ping
      console.info('[Meta Webhook] Signed event contained no message or status update.');
      return res.status(200).json({ status: 'IGNORED_NO_MESSAGE' });
    }

    const messageId = message.id;
    if (!messageId) {
      return res.status(400).json({ error: 'Webhook message is missing its Meta message ID.' });
    }
    if (!await claimWebhookMessage(messageId)) {
      return res.status(200).json({ status: 'DUPLICATE_IGNORED' });
    }
    claimedMessageId = messageId;

    const fromNumber = message.from || '+15552345678';
    const customerName = contact?.profile?.name || 'WhatsApp Customer';
    const textBody = message.text?.body || message.button?.text || '';
    const [persistedSession, persistedOrders, stock, catalogue, webhookTenant] = await Promise.all([
      getWhatsAppSession(fromNumber, tenantId),
      listTenantOrders(tenantId),
      commerce.conversationStock(tenantId),
      commerce.state.listProducts(tenantId),
      // The webhook has no caller identity, so it is pinned to the configured
      // default tenant. If that tenant is not registered this throws and the
      // event is released for retry rather than priced against a guess.
      tenants.require(tenantId),
    ]);
    if (persistedSession) whatsappService.restoreSession(persistedSession);

    const result = await whatsappService.processInboundMessage({
      messageId,
      fromNumber,
      customerName,
      textBody,
      stock,
      products: catalogue,
      orders: persistedOrders,
      tenant: webhookTenant,
    });
    const session = whatsappService.getSession(fromNumber, customerName);
    await Promise.all([
      saveWhatsAppMessages(tenantId, whatsappService.getMessages()),
      saveWhatsAppSession(session, tenantId),
      ...(result.orderCreated ? [saveOrder(result.orderCreated)] : []),
    ]);
    claimedMessageId = undefined;

    console.info('[Meta Webhook] Inbound message processed.');
    return res.status(200).json({
      status: 'PROCESSED',
      reply: result.responseText,
      toolUsed: result.toolUsed,
      humanTakeoverActive: result.humanTakeoverActive,
      orderCreatedId: result.orderCreated?.id,
    });
  } catch (err: unknown) {
    if (claimedMessageId) {
      try {
        await releaseWebhookMessage(claimedMessageId);
      } catch (releaseError) {
        console.error('[Meta Webhook] Could not release failed event idempotency record.', releaseError);
      }
    }
    console.error('Webhook processing error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal webhook error',
    });
  }
};

app.post('/api/whatsapp/webhook', handleInboundWebhook);
app.post('/api/webhooks/whatsapp', handleInboundWebhook);

app.post(
  '/api/web-chat',
  requireRoles(
    'SUPER_ADMIN',
    'BUSINESS_OWNER',
    'SALES_STAFF',
    'FULFILLMENT_STAFF',
    'SUPPORT_STAFF',
    'CUSTOMER'
  ),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    if (!await consumeWebChatQuota(user.id, user.tenantId)) {
      res.status(429).json({ error: 'Chat message limit reached. Wait a minute before trying again.' });
      return;
    }

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const textBody = typeof req.body?.text === 'string'
      ? req.body.text
      : message?.text?.body || message?.button?.text;
    if (typeof textBody !== 'string' || !textBody.trim() || textBody.length > 2000) {
      res.status(400).json({ error: 'Enter a message between 1 and 2,000 characters.' });
      return;
    }

    const fromNumber = `web-${user.id}`;
    const messageId = `web-${randomUUID()}`;
    const [persistedSession, persistedOrders, stock, catalogue] = await Promise.all([
      getWhatsAppSession(fromNumber, user.tenantId),
      listTenantOrders(user.tenantId),
      commerce.conversationStock(user.tenantId),
      commerce.state.listProducts(user.tenantId),
    ]);
    // Web chat has no provider credentials or shared message buffer. A request
    // restores only this account's tenant-scoped conversation.
    const webChatService = new WhatsAppCloudService();
    if (persistedSession) webChatService.restoreSession(persistedSession);

    const result = await webChatService.processWebChatMessage({
      messageId,
      fromNumber,
      customerName: user.name,
      textBody: textBody.trim(),
      stock,
      products: catalogue,
      orders: persistedOrders,
      tenant: await tenants.require(user.tenantId),
    });
    const session = webChatService.getSession(fromNumber, user.name);
    await saveWhatsAppSession(session, user.tenantId);
    res.json({
      status: 'PROCESSED',
      reply: result.responseText,
      toolUsed: result.toolUsed,
      fromNumber,
    });
  })
);

app.post('/api/assistant/chat', requireRoles(...ASSISTANT_ROLES), asyncRoute(async (req, res) => {
  try {
    res.json(await assistant.chat(getRequestUser(req), req.body?.text));
  } catch (error) {
    if (error instanceof AssistantError) {
      if (error.status === 429) res.setHeader('Retry-After', '60');
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}));

app.get('/health', (_req: Request, res: Response) => {
  const config = whatsappService.getConfig();
  res.status(200).json({
    status: 'ok',
    commerce: {
      backend: commerce.backend,
      durable: commerce.backend === 'firestore',
      referenceCatalogue: seedReferenceCatalogue,
    },
    whatsapp: {
      mode: config.mode,
      verifyTokenConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
      appSecretConfigured: Boolean(config.hasAppSecret),
      accessTokenConfigured: Boolean(config.hasAccessToken),
      phoneNumberIdConfigured: Boolean(config.phoneNumberId),
      replyConfigurationComplete: config.mode !== 'SIMULATED_DEMO' &&
        Boolean(config.hasAccessToken) &&
        Boolean(config.phoneNumberId),
    },
    assistant: {
      configured: geminiConfig.enabled && Boolean(geminiConfig.project),
      provider: 'GEMINI_VERTEX_AI',
      model: geminiConfig.model,
      readOnly: true,
    },
    authentication: {
      projectConfigured: Boolean(
        process.env.FIREBASE_PROJECT_ID ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT
      ),
      ownerEmailConfigured: Boolean(
        process.env.OWNER_EMAILS || process.env.OWNER_EMAIL
      ),
      allowedFrontendOriginsConfigured: allowedOrigins.size > 0,
    },
    payments: {
      mpesaConfigured: Boolean(mpesaConfig),
      mpesaEnvironment: mpesaConfig?.environment ?? null,
      simulatedSettlementsAllowed:
        process.env.NODE_ENV !== 'production' && (mpesaConfig?.allowSimulated ?? false),
    },
  });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = getRequestUser(req);
  res.json({
    user: { ...user, canManageSharedWhatsApp: canManageSharedWhatsApp(user) },
    requiresEmailVerification: process.env.REQUIRE_EMAIL_VERIFIED === 'true',
  });
});

app.get('/api/onboarding/business/pending', commerceRoute(async (req, res) => {
  const user = getRequestUser(req);
  res.json({ pendingWorkspace: user.role === 'CUSTOMER' ? await getPendingBusinessWorkspace(user.id) : null });
}));

app.put('/api/onboarding/business/pending', requireRoles('CUSTOMER'), commerceRoute(async (req, res) => {
  const user = getRequestUser(req);
  // Apply the same validation as final provisioning, without trusting a client UID.
  const validated = normalizeTenant({
    id: 'pending-workspace', name: req.body?.businessName,
    currency: req.body?.currency ?? 'KES', channels: ['WEB'],
  });
  const pendingWorkspace = { businessName: validated.name, currency: validated.currency };
  try {
    await savePendingBusinessWorkspace(user.id, pendingWorkspace);
    res.json({ pendingWorkspace });
  } catch (error) {
    if (error instanceof WorkspaceProvisioningConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
}));

app.post(
  '/api/onboarding/business',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    if (!user.emailVerified) {
      res.status(403).json({ error: 'Verify your email address before creating a workspace.' });
      return;
    }
    const isRetry = user.role === 'BUSINESS_OWNER';
    if (user.role !== 'CUSTOMER' && !isRetry) {
      res.status(409).json({ error: 'This account cannot create another business workspace.' });
      return;
    }

    const requestId = randomUUID();
    const tenantId = `tenant-${createHash('sha256').update(user.id).digest('hex').slice(0, 32)}`;
    if (isRetry) {
      if (user.tenantId !== tenantId) {
        res.status(409).json({ error: 'This account already belongs to another business workspace.' });
        return;
      }
      const savedTenant = await tenants.require(tenantId);
      const owner = await provisionTenantForOwner(savedTenant, user.id);
      res.json({ tenant: savedTenant, user: owner });
      return;
    }
    const draft = req.body?.businessName === undefined ? await getPendingBusinessWorkspace(user.id) : null;
    const name = req.body?.businessName ?? draft?.businessName;
    const slugSource = typeof req.body?.slug === 'string' ? req.body.slug : name;
    const slugBase = String(slugSource ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 42) || 'workspace';
    const tenant = normalizeTenant({
      id: tenantId,
      name,
      slug: `${slugBase}-${requestId.slice(0, 8)}`,
      currency: req.body?.currency ?? draft?.currency ?? 'KES',
      locale: 'en-KE',
      timezone: 'Africa/Nairobi',
      taxRatePercent: 0,
      taxInclusive: true,
      reservationTTLMinutes: 15,
      channels: ['WEB'],
    });

    try {
      const owner = await provisionTenantForOwner(tenant, user.id);
      const savedTenant = await tenants.require(tenant.id);
      res.status(isRetry ? 200 : 201).json({ tenant: savedTenant, user: owner });
    } catch (error) {
      if (error instanceof WorkspaceProvisioningConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

// 2b. Tenant configuration. Reads are open to any signed-in member of the
// workspace; writes are owner/admin only. Registration is platform-operator only.
app.get(
  '/api/tenant',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    res.json({ tenant: await tenants.require(user.tenantId) });
  })
);

app.patch(
  '/api/tenant',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const updated = await tenants.update(user.tenantId, req.body || {});
    res.json({ tenant: updated });
  })
);

app.get(
  '/api/tenants',
  requireRoles('SUPER_ADMIN'),
  commerceRoute(async (_req, res) => {
    res.json({ tenants: await tenants.list() });
  })
);

app.post(
  '/api/tenants',
  requireRoles('SUPER_ADMIN'),
  commerceRoute(async (req, res) => {
    const created = await tenants.create(req.body || {});
    // Outside production a new workspace starts with the reference catalogue so it
    // is immediately demoable rather than an empty shell.
    if (seedReferenceCatalogue) await commerce.seed(created.id, SEED_INVENTORIES, SEED_PRODUCTS);
    res.status(201).json({ tenant: created });
  })
);

app.get(
  '/api/users',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    res.json({ users: await listTenantUsers(user.tenantId) });
  })
);

app.post(
  '/api/users',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
    const actor = getRequestUser(req);
    const { name, email, role } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Customer full name is required.' });
      return;
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'A valid email address is required.' });
      return;
    }
    try {
      const newUser = await createTenantCustomer(actor.tenantId, {
        name: name.trim(),
        email: email.trim(),
        role: role || 'CUSTOMER',
      });
      res.status(201).json({ user: newUser });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create customer record.';
      if (message === 'A customer or user with this email address already exists.') {
        res.status(409).json({ error: message });
        return;
      }
      if (message === 'Only customer and staff roles may be assigned from the workspace.') {
        res.status(400).json({ error: message });
        return;
      }
      throw err;
    }
  })
);

app.put(
  '/api/users/:id/role',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
    const actor = getRequestUser(req);
    const role = req.body?.role;
    const assignableRoles = ['CUSTOMER', 'SALES_STAFF', 'FULFILLMENT_STAFF', 'SUPPORT_STAFF'];
    if (!assignableRoles.includes(role)) {
      res.status(400).json({ error: 'Choose a customer or staff role. Owner roles are assigned outside the app.' });
      return;
    }

    try {
      const user = await updateTenantUserRole(
        actor.tenantId,
        actor.id,
        req.params.id,
        role
      );
      if (!user) {
        res.status(404).json({ error: 'Team member not found in your business.' });
        return;
      }
      res.json({ success: true, user });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'The role update was rejected.',
      });
    }
  })
);

// Apply one policy to every shared provider operation, including future routes.
// Webhooks retain their signature/challenge checks; reads below are tenant-safe.
app.use('/api/whatsapp', sharedWhatsAppAccessPolicy);

// 3. Configuration Management API (GET & POST)
app.get('/api/whatsapp/config', (req: Request, res: Response) => {
  const user = getRequestUser(req);
  const conf = whatsappService.getConfig();
  if (user.tenantId !== tenantId && !canManageSharedWhatsApp(user)) {
    return res.json({ mode: 'SIMULATED_DEMO', displayPhoneNumber: '', connected: false });
  }
  if (canManageSharedWhatsApp(user)) {
    return res.json({
      ...conf,
      tenantId,
      webhookCallbackUrl: `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`,
    });
  }
  return res.json({
    mode: conf.mode,
    displayPhoneNumber: conf.displayPhoneNumber,
  });
});

app.post(
  '/api/whatsapp/config',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  (req: Request, res: Response) => {
  const {
    mode,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    verifyToken,
    accessToken,
    appSecret,
    graphApiVersion,
    authorizedTestRecipient,
    autoAiReplies,
    aiBusinessPrompt,
  } = req.body;

  // Input validation
  const validModes = ['DEVELOPER_SANDBOX', 'CLIENT_BUSINESS_LIVE', 'SIMULATED_DEMO', 'META_TEST', 'LIVE_PRODUCTION'];
  if (mode && !validModes.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode. Must be one of: ${validModes.join(', ')}` });
  }
  if (phoneNumberId && /\D/.test(phoneNumberId.trim())) {
    return res.status(400).json({ error: 'Phone Number ID must contain only digits.' });
  }
  if (wabaId && /\D/.test(wabaId.trim())) {
    return res.status(400).json({ error: 'WABA ID must contain only digits.' });
  }

  const updated = whatsappService.updateConfig(
    {
      mode,
      wabaId: wabaId ? wabaId.trim() : undefined,
      phoneNumberId: phoneNumberId ? phoneNumberId.trim() : undefined,
      displayPhoneNumber: displayPhoneNumber ? displayPhoneNumber.trim() : undefined,
      verifyToken: verifyToken ? verifyToken.trim() : undefined,
      graphApiVersion: graphApiVersion ? graphApiVersion.trim() : undefined,
      authorizedTestRecipient: authorizedTestRecipient ? authorizedTestRecipient.trim() : undefined,
      autoAiReplies,
      aiBusinessPrompt,
    },
    accessToken,
    appSecret
  );
  res.json({ success: true, config: updated });
  }
);

// 4. Outbound / Test Message Trigger (POST)
app.post(
  '/api/whatsapp/send',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
  const { to, message, template } = req.body;
  if (!to || (!message && !template)) {
    res.status(400).json({ error: 'Missing "to" or "message"/"template" parameter' });
    return;
  }

  const result = await whatsappService.dispatchMetaGraphApi(
    to,
    message || '',
    undefined,
    template ? { template } : undefined
  );
  res.json(result);
  })
);

// 5. Message History & Webhook Logs (GET & POST)
app.get(
  '/api/whatsapp/messages',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    res.json({ messages: await listTenantMessages(canManageSharedWhatsApp(user) ? tenantId : user.tenantId) });
  })
);

app.post(
  '/api/whatsapp/messages',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
  const { toNumber, customerName, textBody, orderId } = req.body;
  if (!toNumber || !textBody) {
    res.status(400).json({ error: 'Missing toNumber or textBody' });
    return;
  }
  const msg = whatsappService.sendAgentMessage(toNumber, customerName || 'Customer', textBody, orderId);
  await saveWhatsAppMessages(tenantId, [msg]);
  res.json({ success: true, message: msg });
  })
);

app.get(
  '/api/whatsapp/logs',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF', 'SUPER_ADMIN'),
  (_req: Request, res: Response) => {
  res.json({
    logs: whatsappService.getWebhookLogs(),
  });
  }
);

// 6. Reset Session
app.post(
  '/api/whatsapp/reset',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF', 'SUPER_ADMIN'),
  (req: Request, res: Response) => {
  const { phoneNumber } = req.body;
  if (phoneNumber) {
    whatsappService.resetSession(phoneNumber);
  }
  res.json({ success: true });
  }
);

// 7. Live Meta Graph API Status Check
app.get(
  '/api/whatsapp/status',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
  const phoneId = req.query.phoneId as string | undefined;
  const result = await whatsappService.fetchPhoneLiveStatus(phoneId);
  res.json(result);
  })
);

// 8. Submit 6-digit SMS verification code to Meta
app.post(
  '/api/whatsapp/verify-code',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
  const { code, phoneId } = req.body;
  if (!code) {
    res.status(400).json({ error: 'Verification code is required.' });
    return;
  }
  const result = await whatsappService.verifyPhoneCode(code, phoneId);
  res.json(result);
  })
);

// 9. Request a new SMS or Voice code from Meta
app.post(
  '/api/whatsapp/request-code',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
  const { method, language, phoneId } = req.body;
  const result = await whatsappService.requestPhoneCode(method || 'SMS', language || 'en', phoneId);
  res.json(result);
  })
);

// 10. Direct Registration with 6-digit PIN
app.post(
  '/api/whatsapp/register',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
  const { pin, phoneId } = req.body;
  const result = await whatsappService.registerPhone(pin || '123456', phoneId);
  res.json(result);
  })
);

// 11. Synchronized Central Orders API
app.get(
  '/api/orders',
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const tenantOrders = await listTenantOrders(user.tenantId);
    const visibleOrders = user.role === 'CUSTOMER'
      ? tenantOrders.filter((order) => order.customerId === user.id)
      : tenantOrders;
    res.json({ orders: visibleOrders });
  })
);

app.post(
  '/api/orders',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const body = req.body || {};
    const isCustomer = user.role === 'CUSTOMER';
    const orderTenant = await tenants.require(user.tenantId);

    // A customer session may only buy for itself. Staff placing an order on a
    // customer's behalf may name the buyer, but the prices still come from us.
    const customer = {
      id: isCustomer ? user.id : (typeof body.customer?.id === 'string' ? body.customer.id : undefined),
      name: isCustomer ? user.name : (body.customer?.name || user.name),
      email: isCustomer ? user.email : (body.customer?.email || user.email),
      phone: body.customer?.phone,
    };

    const result = await createOrderFromIntake(
      {
        items: Array.isArray(body.items)
          ? body.items.map((line: any) => ({ sku: line?.sku, quantity: line?.quantity }))
          : [],
        customer,
        shippingAddress: body.shippingAddress,
        paymentMethod: body.paymentMethod || 'MPESA_PAYBILL',
        discountCode: body.discountCode,
        mpesaPhoneNumber: body.mpesaPhoneNumber,
        notes: body.notes,
        claimedTotalCents: typeof body.totalCents === 'number' ? body.totalCents : undefined,
      },
      {
        tenant: orderTenant,
        state: commerce.state,
        products: await commerce.state.listProducts(orderTenant.id),
        nextOrderId: () => nextOrderSequence(orderTenant.id),
      }
    );

    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        ...(result.sku ? { sku: result.sku } : {}),
        ...(typeof result.availableStock === 'number' ? { availableStock: result.availableStock } : {}),
      });
      return;
    }

    if (result.warnings.length > 0) {
      console.warn(`[Orders] ${result.order.id} accepted with warnings:`, result.warnings);
    }
    await saveOrder(result.order);
    res.status(201).json({
      success: true,
      order: result.order,
      reservationIds: result.reservationIds,
      warnings: result.warnings,
    });
  })
);

app.put(
  '/api/orders/:id',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN', 'SALES_STAFF', 'FULFILLMENT_STAFF', 'SUPPORT_STAFF'),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const currentOrder = await getTenantOrder(user.tenantId, req.params.id);
    if (!currentOrder) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    const body = req.body || {};
    const targetStatus = typeof body.status === 'string'
      ? (body.status as OrderStatus)
      : undefined;

    let updatedOrder: Order = currentOrder;
    if (targetStatus && targetStatus !== currentOrder.status) {
      const transition = transitionOrder(currentOrder, targetStatus, {
        actor: user.email,
        actorRole: user.role,
        reason: typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : `Status changed to ${targetStatus} from the operations workspace.`,
        metadata: {
          ...(typeof body.trackingNumber === 'string' ? { trackingNumber: body.trackingNumber } : {}),
          ...(typeof body.shippingCarrier === 'string'
            ? { shippingCarrier: body.shippingCarrier }
            : {}),
        },
      });
      if (!transition.success) {
        res.status(409).json({ error: transition.error || 'That status change is not permitted.' });
        return;
      }
      updatedOrder = transition.order;
    }

    // The delivery address belongs to the customer, not the courier. Support may
    // correct it while the parcel is still ours to redirect, but not after.
    if (body.shippingAddress !== undefined) {
      if (!ADDRESS_EDITABLE_STATUSES.includes(updatedOrder.status)) {
        res.status(409).json({
          error: `Order ${updatedOrder.id} is ${updatedOrder.status}; the delivery address can no longer be changed.`,
        });
        return;
      }
      const address = normalizeAddressPatch(body.shippingAddress, updatedOrder.shippingAddress);
      if (!address.ok) {
        res.status(400).json({ error: address.error });
        return;
      }
      updatedOrder = {
        ...updatedOrder,
        shippingAddress: address.value,
        auditTrail: [
          ...updatedOrder.auditTrail,
          {
            id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            fromStatus: updatedOrder.status,
            toStatus: updatedOrder.status,
            actor: user.email,
            actorRole: user.role,
            reason: 'Delivery address amended before dispatch.',
          },
        ],
      };
    }

    // Shipment fields are free text, not part of the state machine.
    updatedOrder = {
      ...updatedOrder,
      ...(typeof body.trackingNumber === 'string' ? { trackingNumber: body.trackingNumber } : {}),
      ...(typeof body.shippingCarrier === 'string' ? { shippingCarrier: body.shippingCarrier } : {}),
      ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      updatedAt: new Date().toISOString(),
    };

    // Stock follows the order: confirming takes the units, cancelling returns them.
    await reconcileReservations(user.tenantId, updatedOrder);

    await saveOrder(updatedOrder);
    res.json({ success: true, order: updatedOrder });
  })
);

/**
 * Records a verified payment against an order and confirms it.
 *
 * Deliberately separate from PUT /api/orders/:id: marking an order paid is not a
 * status edit a workspace user should be able to fold into a bulk update, and the
 * state machine refuses CONFIRMED for a prepaid order without this flag.
 */
app.post(
  '/api/orders/:id/payment',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN', 'SALES_STAFF'),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const currentOrder = await getTenantOrder(user.tenantId, req.params.id);
    if (!currentOrder) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    const transactionRef = typeof req.body?.transactionRef === 'string'
      ? req.body.transactionRef.trim()
      : '';
    if (!transactionRef) {
      res.status(400).json({ error: 'A payment reference is required to confirm payment.' });
      return;
    }
    // This route is a staff attestation for money that arrived outside Daraja
    // (bank transfer, cheque, cash). An M-Pesa order must settle through the
    // authenticated callback, otherwise any user with the right role could mark
    // a mobile-money order paid without a shilling changing hands.
    if (currentOrder.paymentMethod === 'MPESA_PAYBILL' || currentOrder.paymentMethod === 'MPESA_EXPRESS') {
      res.status(409).json({
        error: 'M-Pesa orders settle through the Daraja callback, not manual confirmation.',
      });
      return;
    }

    // Idempotent: a replayed payment webhook must not re-confirm or re-commit.
    if (currentOrder.isPaid && currentOrder.status === 'CONFIRMED') {
      res.json({ success: true, order: currentOrder });
      return;
    }

    const transition = transitionOrder(currentOrder, 'CONFIRMED', {
      actor: user.email,
      actorRole: user.role,
      reason: `Payment verified against reference ${transactionRef}.`,
      paymentConfirmed: true,
    });
    if (!transition.success) {
      res.status(409).json({ error: transition.error || 'This order cannot be marked paid.' });
      return;
    }

    const paidOrder: Order = {
      ...transition.order,
      isPaid: true,
      paymentTransactionRef: transactionRef,
      updatedAt: new Date().toISOString(),
    };

    await reconcileReservations(user.tenantId, paidOrder);
    await saveOrder(paidOrder);
    res.json({ success: true, order: paidOrder });
  })
);

// 11b. M-Pesa (Safaricom Daraja): request, settle, reconcile
//
// Orders are never marked paid on the strength of a client claim. Money arrives
// as a callback signed off by Safaricom's own CheckoutRequestID, and the amount
// is compared against what we asked for before stock is committed.
const settlementDeps = {
  state: commerce.state,
  findOrderByCheckoutRequestId,
  saveOrder,
};

function sendMpesaError(res: Response, error: unknown): boolean {
  if (error instanceof MpesaRequestError) {
    console.error('[M-Pesa] Daraja request failed.', error.message, error.detail ?? '');
    // 502: Safaricom failed us, not the caller's fault, and it is worth retrying.
    res.status(502).json({ error: error.message });
    return true;
  }
  return false;
}

app.post(
  '/api/orders/:id/mpesa/stk-push',
  requireRoles(
    'SUPER_ADMIN',
    'BUSINESS_OWNER',
    'SALES_STAFF',
    'SUPPORT_STAFF',
    'CUSTOMER'
  ),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const order = await getTenantOrder(user.tenantId, req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    if (user.role === 'CUSTOMER' && order.customerId !== user.id) {
      res.status(403).json({ error: 'You can only pay for your own order.' });
      return;
    }
    if (order.isPaid) {
      res.status(409).json({ error: 'This order is already paid.' });
      return;
    }
    if (order.paymentMethod === 'CASH_ON_DELIVERY') {
      res.status(400).json({ error: 'Cash on delivery orders are settled by the courier.' });
      return;
    }
    if (order.status !== 'AWAITING_PAYMENT' && order.status !== 'PAYMENT_FAILED') {
      res.status(409).json({ error: `Order status ${order.status} cannot request a payment.` });
      return;
    }

    const requestedPhone =
      req.body?.phone || order.mpesaPhoneNumber || order.customerPhone || '';
    const phone = normalizeKenyanPhone(String(requestedPhone));
    if (!phone) {
      res.status(400).json({
        error: 'A valid Kenyan mobile number is required to send an M-Pesa prompt.',
      });
      return;
    }

    const amountKes = amountKesFromCents(order.totalCents);
    if (amountKes <= 0) {
      res.status(400).json({ error: 'This order has no payable amount.' });
      return;
    }

    let client;
    try {
      client = createDarajaClient(mpesaConfig);
    } catch (error) {
      res.status(503).json({
        error:
          'M-Pesa is not configured on this deployment. Set the MPESA_* environment ' +
          'variables to enable mobile-money checkout.',
      });
      return;
    }

    let accepted;
    try {
      accepted = await client.requestStkPush({
        phone,
        amountKes,
        accountReference: order.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12),
        description: `Order ${order.id}`,
      });
    } catch (error) {
      if (sendMpesaError(res, error)) return;
      throw error;
    }

    // Retrying after a declined prompt must re-open the order for payment.
    let pending: Order = order;
    if (order.status === 'PAYMENT_FAILED') {
      const reopened = transitionOrder(order, 'AWAITING_PAYMENT', {
        actor: user.email,
        actorRole: user.role,
        reason: 'M-Pesa payment prompt requested again.',
      });
      if (reopened.success) pending = reopened.order;
    }

    const withCheckout: Order = {
      ...pending,
      mpesaCheckoutRequestId: accepted.checkoutRequestId,
      mpesaMerchantRequestId: accepted.merchantRequestId,
      mpesaAmountKes: accepted.requestedAmountKes,
      mpesaPhoneNumber: phone,
      updatedAt: new Date().toISOString(),
    };
    await saveOrder(withCheckout);

    res.status(202).json({
      success: true,
      checkoutRequestId: accepted.checkoutRequestId,
      customerMessage: accepted.customerMessage,
      amountKes: accepted.requestedAmountKes,
      status: withCheckout.status,
    });
  })
);

/**
 * Safaricom's settlement callback. Always answered with a 200 envelope: anything
 * else makes Daraja retry the same event, and the retries are then handled by the
 * idempotent settlement path rather than by the transport.
 */
app.post(
  '/api/payments/mpesa/callback',
  asyncRoute(async (req, res) => {
    const result = await handleStkCallback(settlementDeps, req.body);
    if (result.status === 'SETTLED') {
      console.info(`[M-Pesa] Settled ${result.order.id} (${result.receipt}).`);
    } else if (result.status !== 'ALREADY_SETTLED') {
      console.warn('[M-Pesa] Callback not applied:', result.status, result);
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  })
);

/**
 * Reconciliation for a callback that never arrived. Reports what Safaricom says
 * rather than guessing, and settles only when Daraja itself confirms payment.
 */
app.get(
  '/api/payments/mpesa/:checkoutRequestId/status',
  requireRoles(
    'SUPER_ADMIN',
    'BUSINESS_OWNER',
    'SALES_STAFF',
    'SUPPORT_STAFF',
    'CUSTOMER'
  ),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const checkoutRequestId = req.params.checkoutRequestId;
    const order = await findOrderByCheckoutRequestId(checkoutRequestId);
    if (!order || order.tenantId !== user.tenantId) {
      res.status(404).json({ error: 'No order matches that checkout request.' });
      return;
    }
    if (user.role === 'CUSTOMER' && order.customerId !== user.id) {
      res.status(403).json({ error: 'You can only track your own payment.' });
      return;
    }

    let client;
    try {
      client = createDarajaClient(mpesaConfig);
    } catch {
      res.status(503).json({ error: 'M-Pesa is not configured on this deployment.' });
      return;
    }

    let query;
    try {
      query = await client.queryStkPush(checkoutRequestId);
    } catch (error) {
      if (sendMpesaError(res, error)) return;
      throw error;
    }

    res.json({
      orderId: order.id,
      orderStatus: order.status,
      isPaid: order.isPaid,
      daraja: query,
      // Daraja's status query does not return the receipt number, so a payment
      // recovered this way still needs its receipt reconciled by staff.
      requiresManualReconciliation: query.paid && !order.isPaid,
    });
  })
);

/**
 * Local-development shortcut for the demo checkout. Refused outside development
 * and without an explicit opt-in, and its receipt is unmistakably synthetic.
 */
app.post(
  '/api/payments/mpesa/simulate',
  requireRoles('SUPER_ADMIN', 'BUSINESS_OWNER', 'SALES_STAFF'),
  commerceRoute(async (req, res) => {
    const allowed =
      process.env.NODE_ENV !== 'production' && (mpesaConfig?.allowSimulated ?? false);
    if (!allowed) {
      res.status(403).json({
        error:
          'Simulated settlements are disabled. They require NODE_ENV!=production and ' +
          'MPESA_ALLOW_SIMULATED=true.',
      });
      return;
    }

    const user = getRequestUser(req);
    const orderId = String(req.body?.orderId || '').trim();
    const order = await getTenantOrder(user.tenantId, orderId);
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    const result = await simulateSettlement(settlementDeps, order);
    if (result.status !== 'SETTLED' && result.status !== 'ALREADY_SETTLED') {
      res.status(409).json({ error: `Simulated settlement not applied: ${result.status}.` });
      return;
    }
    res.json({ success: true, order: result.order, receipt: result.order.mpesaReceiptCode });
  })
);

// 11c. Returns: request, receive, inspect, refund
//
// Four separate steps on purpose. The customer asking changes no stock; only a
// human grading the goods can put anything back on the shelf, and only then is a
// refund queued. See returns.ts for the arithmetic.
const RETURN_REASONS: ReturnReason[] = [
  'DAMAGED_IN_TRANSIT',
  'WRONG_ITEM',
  'NOT_AS_DESCRIBED',
  'FAULTY',
  'CHANGED_MIND',
];
const RETURN_STATUSES: ReturnStatus[] = ['REQUESTED', 'RECEIVED', 'INSPECTED', 'REJECTED', 'CLOSED'];

/**
 * Where each returned SKU should land. The reservation remembers which shelf the
 * units left from, which is exactly where they belong when they come back.
 */
async function resolveReturnWarehouses(
  scopedTenantId: string,
  order: Order
): Promise<Record<string, string>> {
  const [reservations, inventory] = await Promise.all([
    commerce.state.listReservations(scopedTenantId, { orderId: order.id }),
    commerce.state.listInventory(scopedTenantId),
  ]);

  const resolved: Record<string, string> = {};
  for (const item of order.items) {
    const warehouseId =
      reservations.find((reservation) => reservation.sku === item.sku)?.warehouseId ??
      inventory.find((row) => row.sku === item.sku)?.warehouseId;
    if (warehouseId) resolved[item.sku] = warehouseId;
  }
  return resolved;
}

app.get(
  '/api/returns',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
    let records = await listTenantReturns(user.tenantId);
    if (user.role === 'CUSTOMER') {
      records = records.filter((record) => record.customerId === user.id);
    }
    if (RETURN_STATUSES.includes(status as ReturnStatus)) {
      records = records.filter((record) => record.status === status);
    }
    res.json({ returns: records });
  })
);

app.get(
  '/api/returns/:id',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const record = await getTenantReturn(user.tenantId, req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Return not found.' });
      return;
    }
    if (user.role === 'CUSTOMER' && record.customerId !== user.id) {
      res.status(403).json({ error: 'You can only view your own return.' });
      return;
    }
    res.json({ returnRequest: record, order: await getTenantOrder(user.tenantId, record.orderId) });
  })
);

app.post(
  '/api/returns',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) {
      res.status(400).json({ error: 'An orderId is required.' });
      return;
    }

    const order = await getTenantOrder(user.tenantId, orderId);
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    if (user.role === 'CUSTOMER' && order.customerId !== user.id) {
      res.status(403).json({ error: 'You can only return your own order.' });
      return;
    }

    // Allocate before validating: a refused claim burns a number, which is
    // preferable to a return id that silently depends on a later read.
    const returnId = `RET-${String(await nextReturnSequence(user.tenantId)).padStart(6, '0')}`;
    const existingReturns = (await listTenantReturns(user.tenantId)).filter(
      (record) => record.orderId === order.id
    );

    const result = createReturnRequest(
      {
        order,
        lines: Array.isArray(req.body?.lines)
          ? req.body.lines.map((line: any) => ({ sku: line?.sku, quantity: line?.quantity }))
          : [],
        reason: req.body?.reason as ReturnReason,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
        warehouseBySku: await resolveReturnWarehouses(user.tenantId, order),
        actor: user.email,
        actorRole: user.role,
        existingReturns,
      },
      { nextReturnId: () => returnId }
    );

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    await Promise.all([saveOrder(result.order), saveReturnRequest(result.returnRequest)]);
    res.status(201).json({
      success: true,
      order: result.order,
      returnRequest: result.returnRequest,
    });
  })
);

/**
 * Loads a return and its order, enforcing that a caller only reaches their own
 * records. Returns null after writing the error response.
 */
async function loadReturnForRequest(
  req: Request,
  res: Response
): Promise<{ record: ReturnRequest; order: Order } | null> {
  const user = getRequestUser(req);
  const record = await getTenantReturn(user.tenantId, req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Return not found.' });
    return null;
  }
  if (user.role === 'CUSTOMER' && record.customerId !== user.id) {
    res.status(403).json({ error: 'You can only act on your own return.' });
    return null;
  }
  const order = await getTenantOrder(user.tenantId, record.orderId);
  if (!order) {
    res.status(404).json({ error: 'The order behind this return no longer exists.' });
    return null;
  }
  return { record, order };
}

app.post(
  '/api/returns/:id/receive',
  requireRoles('SUPER_ADMIN', 'BUSINESS_OWNER', 'FULFILLMENT_STAFF'),
  commerceRoute(async (req, res) => {
    const loaded = await loadReturnForRequest(req, res);
    if (!loaded) return;

    const user = getRequestUser(req);
    const result = await receiveReturn(loaded.record, loaded.order, {
      state: commerce.state,
      actor: user.email,
      actorRole: user.role,
      warehouseId: loaded.record.lines[0]?.warehouseId ?? '',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    await saveReturnRequest(result.returnRequest);
    res.json({ success: true, order: result.order, returnRequest: result.returnRequest });
  })
);

app.post(
  '/api/returns/:id/inspect',
  requireRoles('SUPER_ADMIN', 'BUSINESS_OWNER', 'FULFILLMENT_STAFF'),
  commerceRoute(async (req, res) => {
    const loaded = await loadReturnForRequest(req, res);
    if (!loaded) return;

    const decision = req.body?.decision === 'REJECT' ? 'REJECT' : 'APPROVE';
    const user = getRequestUser(req);
    const result = await inspectReturn(
      loaded.record,
      loaded.order,
      {
        decision,
        restock:
          req.body?.restock && typeof req.body.restock === 'object' ? req.body.restock : undefined,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      },
      { state: commerce.state, actor: user.email, actorRole: user.role }
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    await Promise.all([saveOrder(result.order), saveReturnRequest(result.returnRequest)]);
    res.json({ success: true, order: result.order, returnRequest: result.returnRequest });
  })
);

app.post(
  '/api/returns/:id/refund',
  requireRoles('SUPER_ADMIN', 'BUSINESS_OWNER'),
  commerceRoute(async (req, res) => {
    const loaded = await loadReturnForRequest(req, res);
    if (!loaded) return;

    const refundReference = typeof req.body?.refundReference === 'string'
      ? req.body.refundReference.trim()
      : '';
    const user = getRequestUser(req);
    const result = markRefundPaid(
      loaded.record,
      loaded.order,
      { actor: user.email, actorRole: user.role, refundReference },
      {}
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    await Promise.all([saveOrder(result.order), saveReturnRequest(result.returnRequest)]);
    res.json({ success: true, order: result.order, returnRequest: result.returnRequest });
  })
);

// 12. Inventory, reservation, and catalogue API (authoritative store)
const INVENTORY_READERS = ['BUSINESS_OWNER', 'SUPER_ADMIN', 'FULFILLMENT_STAFF', 'SUPPORT_STAFF'] as const;
const INVENTORY_WRITERS = ['BUSINESS_OWNER', 'SUPER_ADMIN', 'FULFILLMENT_STAFF'] as const;

app.get(
  '/api/inventory',
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const [rows, reservations] = await Promise.all([
      commerce.state.listInventory(user.tenantId),
      commerce.state.listReservations(user.tenantId),
    ]);

    // Every authenticated shopper needs to know what is sellable. Only staff get
    // the per-warehouse breakdown and other customers' reservations.
    const seesWarehouseDetail = (INVENTORY_READERS as readonly string[]).includes(user.role);
    const seesReservations = (INVENTORY_WRITERS as readonly string[]).includes(user.role);

    res.json({
      availability: availabilityBySku(rows),
      ...(seesWarehouseDetail ? { inventories: rows } : {}),
      ...(seesReservations ? { reservations } : {}),
    });
  })
);

app.post(
  '/api/inventory/adjust',
  requireRoles(...INVENTORY_WRITERS),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const body = req.body || {};
    const command: AdjustStockCommand = {
      sku: String(body.sku || '').trim().toUpperCase(),
      warehouseId: String(body.warehouseId || '').trim(),
      physicalDelta: Number(body.physicalDelta ?? body.deltaPhysical ?? 0),
      quarantineDelta: Number(body.quarantineDelta ?? 0),
      reason: String(body.reason || '').trim(),
      actor: user.email,
    };

    if (!command.sku || !command.warehouseId) {
      res.status(400).json({ error: 'A SKU and warehouse are required.' });
      return;
    }
    if (!Number.isInteger(command.physicalDelta) || !Number.isInteger(command.quarantineDelta)) {
      res.status(400).json({ error: 'Stock adjustments must be whole numbers.' });
      return;
    }
    if (command.physicalDelta === 0 && command.quarantineDelta === 0) {
      res.status(400).json({ error: 'An adjustment must change physical or quarantine stock.' });
      return;
    }
    if (!command.reason) {
      res.status(400).json({ error: 'A reason is required for every stock adjustment.' });
      return;
    }

    const updated = await commerce.state.adjust(user.tenantId, command);
    if (!updated) {
      res.status(404).json({ error: 'No inventory record matches that SKU and warehouse.' });
      return;
    }
    res.json({ success: true, inventory: updated });
  })
);

app.post(
  '/api/inventory/reserve',
  requireRoles(...INVENTORY_WRITERS),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const body = req.body || {};
    const sku = String(body.sku || '').trim().toUpperCase();
    const quantity = Number(body.quantity);

    if (!sku || !Number.isInteger(quantity) || quantity <= 0) {
      res.status(400).json({ error: 'A SKU and a positive whole quantity are required.' });
      return;
    }

    const result = await commerce.state.reserve(user.tenantId, {
      orderId: String(body.orderId || `MANUAL-${Date.now()}`),
      sku,
      quantity,
      warehouseId: typeof body.warehouseId === 'string' ? body.warehouseId : undefined,
      ttlMinutes: (await tenants.require(user.tenantId)).reservationTTLMinutes || 15,
    });

    res.status(result.success ? 201 : 409).json({
      success: result.success,
      reservation: result.reservation,
      availableStock: result.availableStock,
      requestedQuantity: result.requestedQuantity,
      scenario: result.scenario,
      ...(result.error ? { error: result.error } : {}),
    });
  })
);

app.post(
  '/api/inventory/reservations/:id/commit',
  requireRoles(...INVENTORY_WRITERS),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const committed = await commerce.state.commit(user.tenantId, req.params.id);
    if (!committed) {
      res.status(409).json({ error: 'That reservation is not active any more.' });
      return;
    }
    res.json({ success: true });
  })
);

app.post(
  '/api/inventory/reservations/:id/cancel',
  requireRoles(...INVENTORY_WRITERS),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const cancelled = await commerce.state.cancel(user.tenantId, req.params.id);
    if (!cancelled) {
      res.status(409).json({ error: 'That reservation is not active any more.' });
      return;
    }
    res.json({ success: true });
  })
);

app.post(
  '/api/inventory/sweep',
  requireRoles(...INVENTORY_WRITERS),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const released = await commerce.state.releaseExpired(user.tenantId);
    res.json({ success: true, released });
  })
);

app.get(
  '/api/products',
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    res.json({ products: await commerce.state.listProducts(user.tenantId) });
  })
);

app.post(
  '/api/products',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  commerceRoute(async (req, res) => {
    const user = getRequestUser(req);
    const body = req.body || {};
    const product = body.product as Product | undefined;

    if (!product?.sku || !product?.title) {
      res.status(400).json({ error: 'A SKU and title are required.' });
      return;
    }
    if (!Number.isInteger(product.basePriceCents) || product.basePriceCents <= 0) {
      res.status(400).json({ error: 'The selling price must be a positive whole number of cents.' });
      return;
    }
    if (!Array.isArray(body.inventory)) {
      res.status(400).json({ error: 'Initial stock rows are required.' });
      return;
    }

    const saved = await commerce.state.upsertProduct(user.tenantId, product);
    const now = new Date().toISOString();
    for (const row of body.inventory as WarehouseInventory[]) {
      await commerce.state.upsertInventory(user.tenantId, {
        sku: saved.sku,
        warehouseId: String(row.warehouseId),
        warehouseName: String(row.warehouseName || row.warehouseId),
        physicalStock: Math.max(0, Math.trunc(Number(row.physicalStock) || 0)),
        reservedStock: 0,
        quarantineStock: Math.max(0, Math.trunc(Number(row.quarantineStock) || 0)),
        lowStockThreshold: Math.max(0, Math.trunc(Number(row.lowStockThreshold) || 5)),
        lastReconciledAt: now,
      });
    }

    res.status(201).json({ success: true, product: saved });
  })
);

// Meta App Publishing Compliance: Privacy Policy & Terms of Service endpoints
app.get('/privacy', (_req: Request, res: Response) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - SokoFlow</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1e293b; background: #f8fafc; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 16px; padding: 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { color: #0f172a; margin-top: 0; font-size: 26px; }
    h2 { color: #334155; font-size: 18px; margin-top: 24px; }
    p, li { color: #475569; font-size: 14px; }
    .badge { display: inline-block; background: #ecfdf5; color: #047857; font-weight: 600; font-size: 11px; padding: 4px 10px; border-radius: 999px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Official Policy</span>
    <h1>Privacy Policy - SokoFlow</h1>
    <p><em>Last updated: October 2026</em></p>
    <p>SokoFlow ("we", "our", or "us") operates a commerce operations platform, including automated conversational commerce via Meta WhatsApp Business Cloud API.</p>
    <h2>1. Information We Collect</h2>
    <p>When you interact with our WhatsApp messaging bot or storefront, we collect and process your WhatsApp phone number, display profile name, and incoming message text strictly to fulfill your inquiries, check inventory, and manage order deliveries.</p>
    <h2>2. Purpose of Processing</h2>
    <ul>
      <li>Answering product, pricing, and stock availability questions in real time.</li>
      <li>Creating and tracking customer order reservations.</li>
      <li>Sending transactional dispatch and shipping status notifications.</li>
    </ul>
    <h2>3. Data Protection & Sharing</h2>
    <p>We do not sell, rent, or trade your personal data. All messaging data transferred through Meta WhatsApp Cloud API is encrypted in transit under Meta's Cloud API security standards.</p>
    <h2>4. Data Deletion Requests</h2>
    <p>You may request full deletion of your customer record and messaging history at any time by contacting our Data Protection Officer at <strong>nyakegojohn36@gmail.com</strong>.</p>
  </div>
</body>
</html>`);
});

app.get('/terms', (_req: Request, res: Response) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - SokoFlow</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1e293b; background: #f8fafc; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 16px; padding: 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { color: #0f172a; margin-top: 0; font-size: 26px; }
    p { color: #475569; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Terms of Service - SokoFlow</h1>
    <p><em>Last updated: October 2026</em></p>
    <p>By using the SokoFlow platform and its WhatsApp Business automation service, you agree to receive automated transactional updates for your ecommerce purchases and inquiries.</p>
    <p>For inquiries, contact: <strong>nyakegojohn36@gmail.com</strong>.</p>
  </div>
</body>
</html>`);
});

// A path under /api that the app does not implement answers JSON 404, not the
// SPA. Without this the request fell through to the catch-all route and a client
// asking for a renamed or misspelled endpoint got index.html with a 200, which
// fails later as a parse error instead of here as "no such endpoint".
//
// Callers without a token still get 401 first: authentication runs on the whole
// /api prefix before routing, and that is deliberate. A 404 before the token
// check would let anyone map which endpoints exist.
app.all('/api/*', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'No API endpoint matches that path.' });
});

app.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error('[API] Request failed.', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

// 13. Mount Vite dev server middleware or serve dist in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  // Tenant records are data now, so they need the same bootstrap treatment as
  // the catalogue: write the reference tenants once, then trust the database.
  await bootstrapTenants();
  // Bootstrap the durable catalogue once per process. Idempotent: it only writes
  // when the tenant has no inventory or product records yet.
  if (seedReferenceCatalogue) await commerce.seed(tenantId, SEED_INVENTORIES, SEED_PRODUCTS);
  startReservationSweeper(tenantId);

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SokoFlow] Running on http://0.0.0.0:${PORT}`);
  });
}

function handleShutdown(signal: string) {
  console.log(`[SokoFlow] Received ${signal}, closing gracefully...`);
  httpServer.close(() => {
    console.log('[SokoFlow] HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

startServer().catch((err) => {
  console.error('[SokoFlow] Startup error:', err);
  process.exit(1);
});
