/**
 * Safaricom Daraja (M-Pesa) client.
 *
 * What this replaces: the app used to invent M-Pesa receipt codes with
 * `Math.random()` and mark orders paid on the client's word. A receipt code is a
 * settlement instrument, so the only acceptable source is Safaricom itself.
 *
 * Protocol, in the order it happens:
 *   1. OAuth          GET  /oauth/v1/generate?grant_type=client_credentials
 *   2. STK push       POST /mpesa/stkpush/v1/processrequest   -> CheckoutRequestID
 *   3. Callback       POST <our callback url>                 -> receipt + amount
 *   4. Reconciliation POST /mpesa/stkpushquery/v1/query       -> for lost callbacks
 *
 * Tanuki rule: nothing here fabricates a result. When the credentials are
 * absent the client reports itself unconfigured and the API answers 503, because
 * a made-up "PAID" is far worse than an honest outage.
 */

export type MpesaEnvironment = 'sandbox' | 'production';

export type MpesaTransactionType = 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';

export interface MpesaConfig {
  environment: MpesaEnvironment;
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passkey: string;
  callbackUrl: string;
  transactionType: MpesaTransactionType;
  /** Local development only: enables the /simulate route to fake a settlement. */
  allowSimulated: boolean;
}

const ENDPOINTS: Record<MpesaEnvironment, string> = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

const REQUEST_TIMEOUT_MS = 20_000;

export class MpesaNotConfiguredError extends Error {
  missing: string[];

  constructor(missing: string[]) {
    super(`M-Pesa is not configured. Missing: ${missing.join(', ')}.`);
    this.name = 'MpesaNotConfiguredError';
    this.missing = missing;
  }
}

export class MpesaRequestError extends Error {
  status?: number;
  detail?: unknown;

  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = 'MpesaRequestError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Reads credentials from the environment. Returns null when they are absent so
 * callers can distinguish "not set up" from "misconfigured".
 */
export function readMpesaConfig(env: NodeJS.ProcessEnv = process.env): MpesaConfig | null {
  const consumerKey = (env.MPESA_CONSUMER_KEY || '').trim();
  const consumerSecret = (env.MPESA_CONSUMER_SECRET || '').trim();
  const shortCode = (env.MPESA_SHORTCODE || '').trim();
  const passkey = (env.MPESA_PASSKEY || '').trim();
  const callbackUrl = (env.MPESA_CALLBACK_URL || '').trim();

  const missing: string[] = [];
  if (!consumerKey) missing.push('MPESA_CONSUMER_KEY');
  if (!consumerSecret) missing.push('MPESA_CONSUMER_SECRET');
  if (!shortCode) missing.push('MPESA_SHORTCODE');
  if (!passkey) missing.push('MPESA_PASSKEY');
  if (!callbackUrl) missing.push('MPESA_CALLBACK_URL');
  if (missing.length > 0) return null;

  const environment: MpesaEnvironment =
    (env.MPESA_ENVIRONMENT || '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';

  return {
    environment,
    consumerKey,
    consumerSecret,
    shortCode,
    passkey,
    callbackUrl,
    transactionType:
      (env.MPESA_TRANSACTION_TYPE || '').trim() === 'CustomerBuyGoodsOnline'
        ? 'CustomerBuyGoodsOnline'
        : 'CustomerPayBillOnline',
    allowSimulated: (env.MPESA_ALLOW_SIMULATED || '').trim().toLowerCase() === 'true',
  };
}

/**
 * Safaricom only accepts the 2547XXXXXXXX / 2541XXXXXXXX form. Anything else is
 * a hard reject rather than a best-effort guess at what the customer meant.
 */
export function normalizeKenyanPhone(input: string): string | null {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;

  let local = digits;
  if (local.startsWith('254')) local = local.slice(3);
  else if (local.startsWith('0')) local = local.slice(1);
  else if (local.startsWith('2540')) local = local.slice(4);

  if (!/^[17]\d{8}$/.test(local)) return null;
  return `254${local}`;
}

/** Daraja's timestamp format: YYYYMMDDHHMMSS in East Africa Time. */
export function buildStkTimestamp(now: Date = new Date()): string {
  // EAT is a fixed UTC+3 with no daylight saving, so a plain offset is exact.
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${eat.getUTCFullYear()}${pad(eat.getUTCMonth() + 1)}${pad(eat.getUTCDate())}` +
    `${pad(eat.getUTCHours())}${pad(eat.getUTCMinutes())}${pad(eat.getUTCSeconds())}`
  );
}

export function buildStkPassword(shortCode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`, 'utf8').toString('base64');
}

/** M-Pesa transacts in whole shillings; round up so we never undercharge. */
export function amountKesFromCents(totalCents: number): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  return Math.ceil(totalCents / 100);
}

export interface StkPushAccepted {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage: string;
  requestedAmountKes: number;
}

export interface StkQueryResult {
  paid: boolean;
  resultCode: string;
  resultDescription: string;
  /** True while Safaricom still considers the prompt outstanding. */
  pending: boolean;
}

export type StkCallbackOutcome =
  | {
      kind: 'PAID';
      merchantRequestId?: string;
      checkoutRequestId: string;
      receipt: string;
      amountKes: number;
      phoneNumber?: string;
      transactionDate?: string;
    }
  | {
      kind: 'FAILED';
      merchantRequestId?: string;
      checkoutRequestId: string;
      resultCode: number;
      resultDescription: string;
    }
  | { kind: 'MALFORMED'; reason: string };

function readMetadataItem(
  items: unknown,
  name: string
): string | number | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (item && typeof item === 'object' && (item as { Name?: string }).Name === name) {
      const value = (item as { Value?: unknown }).Value;
      if (typeof value === 'string' || typeof value === 'number') return value;
    }
  }
  return undefined;
}

/**
 * Parses Safaricom's callback body. Unknown shapes are reported as MALFORMED
 * rather than guessed at, so a settlement can never be inferred from a partial
 * payload.
 */
export function parseStkCallback(body: unknown): StkCallbackOutcome {
  const stk = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!stk || typeof stk !== 'object') {
    return { kind: 'MALFORMED', reason: 'Missing Body.stkCallback.' };
  }

  const checkoutRequestId = String(stk.CheckoutRequestID ?? '').trim();
  if (!checkoutRequestId) {
    return { kind: 'MALFORMED', reason: 'Missing CheckoutRequestID.' };
  }
  const merchantRequestId = stk.MerchantRequestID ? String(stk.MerchantRequestID) : undefined;

  const resultCode = Number(stk.ResultCode);
  if (!Number.isFinite(resultCode)) {
    return { kind: 'MALFORMED', reason: 'Missing or non-numeric ResultCode.' };
  }
  const resultDescription = String(stk.ResultDesc ?? '');

  if (resultCode !== 0) {
    return {
      kind: 'FAILED',
      merchantRequestId,
      checkoutRequestId,
      resultCode,
      resultDescription,
    };
  }

  const items = (stk.CallbackMetadata as { Item?: unknown })?.Item;
  const receipt = readMetadataItem(items, 'MpesaReceiptNumber');
  const amount = readMetadataItem(items, 'Amount');

  if (typeof receipt !== 'string' || !receipt.trim()) {
    return { kind: 'MALFORMED', reason: 'Successful callback without a receipt number.' };
  }
  const amountKes = Number(amount);
  if (!Number.isFinite(amountKes)) {
    return { kind: 'MALFORMED', reason: 'Successful callback without a numeric amount.' };
  }

  const phone = readMetadataItem(items, 'PhoneNumber');
  const transactionDate = readMetadataItem(items, 'TransactionDate');

  return {
    kind: 'PAID',
    merchantRequestId,
    checkoutRequestId,
    receipt: receipt.trim(),
    amountKes,
    phoneNumber: phone === undefined ? undefined : String(phone),
    transactionDate: transactionDate === undefined ? undefined : String(transactionDate),
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DarajaClient {
  private config: MpesaConfig;
  private fetchImpl: FetchLike;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: MpesaConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get environment(): MpesaEnvironment {
    return this.config.environment;
  }

  private get baseUrl(): string {
    return ENDPOINTS[this.config.environment];
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const credentials = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`
    ).toString('base64');

    const response = await this.fetchImpl(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: 'GET',
        headers: { Authorization: `Basic ${credentials}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      throw new MpesaRequestError(
        `Daraja authentication failed with HTTP ${response.status}.`,
        response.status
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: string | number;
    };
    const token = payload.access_token;
    if (!token) {
      throw new MpesaRequestError('Daraja authentication returned no access_token.');
    }

    const expiresInSeconds = Number(payload.expires_in ?? 3599);
    this.token = {
      value: token,
      // Refreshed a minute early so a request never races the expiry.
      expiresAt: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000,
    };
    return token;
  }

  async requestStkPush(params: {
    phone: string;
    amountKes: number;
    accountReference: string;
    description: string;
  }): Promise<StkPushAccepted> {
    const phone = normalizeKenyanPhone(params.phone);
    if (!phone) {
      throw new MpesaRequestError(`"${params.phone}" is not a Kenyan mobile number.`);
    }
    if (!Number.isInteger(params.amountKes) || params.amountKes <= 0) {
      throw new MpesaRequestError('The M-Pesa amount must be a positive whole number of shillings.');
    }

    const token = await this.accessToken();
    const timestamp = buildStkTimestamp();
    const payload = {
      BusinessShortCode: this.config.shortCode,
      Password: buildStkPassword(this.config.shortCode, this.config.passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: this.config.transactionType,
      Amount: params.amountKes,
      PartyA: phone,
      // PayBill collections are addressed to the short code itself.
      PartyB: this.config.shortCode,
      PhoneNumber: phone,
      CallBackURL: this.config.callbackUrl,
      AccountReference: params.accountReference.slice(0, 12),
      TransactionDesc: params.description.slice(0, 60),
    };

    const response = await this.fetchImpl(`${this.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok) {
      throw new MpesaRequestError(
        `Daraja rejected the STK push with HTTP ${response.status}.`,
        response.status,
        body
      );
    }
    if (!body || String(body.ResponseCode ?? '') !== '0') {
      throw new MpesaRequestError(
        `Daraja rejected the STK push: ${String(body?.ResponseDescription ?? 'no response code')}.`,
        response.status,
        body
      );
    }

    const checkoutRequestId = String(body.CheckoutRequestID ?? '').trim();
    if (!checkoutRequestId) {
      throw new MpesaRequestError('Daraja accepted the STK push without a CheckoutRequestID.', 200, body);
    }

    return {
      merchantRequestId: String(body.MerchantRequestID ?? ''),
      checkoutRequestId,
      customerMessage: String(body.CustomerMessage ?? ''),
      requestedAmountKes: params.amountKes,
    };
  }

  /**
   * Reconciliation path for a lost callback. 1032 is "cancelled by user" and
   * 1037 is "timeout"; both are terminal failures rather than pending.
   */
  async queryStkPush(checkoutRequestId: string): Promise<StkQueryResult> {
    const token = await this.accessToken();
    const timestamp = buildStkTimestamp();

    const response = await this.fetchImpl(`${this.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortCode,
        Password: buildStkPassword(this.config.shortCode, this.config.passkey, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok || !body) {
      throw new MpesaRequestError(
        `Daraja status query failed with HTTP ${response.status}.`,
        response.status,
        body
      );
    }

    const resultCode = String(body.ResultCode ?? '');
    const description = String(body.ResultDesc ?? '');

    // 500.001.1001 = "transaction is being processed", the prompt is still live.
    const pending = resultCode === '' || description.toLowerCase().includes('being processed');

    return {
      paid: resultCode === '0',
      resultCode,
      resultDescription: description,
      pending,
    };
  }
}

export function createDarajaClient(
  config: MpesaConfig | null,
  fetchImpl?: FetchLike
): DarajaClient {
  if (!config) {
    throw new MpesaNotConfiguredError([
      'MPESA_CONSUMER_KEY',
      'MPESA_CONSUMER_SECRET',
      'MPESA_SHORTCODE',
      'MPESA_PASSKEY',
      'MPESA_CALLBACK_URL',
    ]);
  }
  return new DarajaClient(config, fetchImpl);
}
