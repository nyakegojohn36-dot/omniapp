/**
 * Daraja client tests. The transport is injected, so the request shapes are
 * asserted exactly and no network call is ever made.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DarajaClient,
  MpesaRequestError,
  amountKesFromCents,
  buildStkPassword,
  buildStkTimestamp,
  normalizeKenyanPhone,
  parseStkCallback,
  readMpesaConfig,
  type MpesaConfig,
} from './mpesaDaraja.ts';

const CONFIG: MpesaConfig = {
  environment: 'sandbox',
  consumerKey: 'key',
  consumerSecret: 'secret',
  shortCode: '174379',
  passkey: 'passkey',
  callbackUrl: 'https://example.test/api/payments/mpesa/callback',
  transactionType: 'CustomerPayBillOnline',
  allowSimulated: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

/** Routes /oauth, /stkpush and /stkpushquery to canned responses. */
function transport(options: {
  token?: () => Response;
  stk?: () => Response;
  query?: () => Response;
}) {
  const calls: CapturedCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.includes('/oauth/v1/generate')) {
      return options.token ? options.token() : jsonResponse({ access_token: 'token-1', expires_in: 3599 });
    }
    if (url.includes('/stkpush/v1/processrequest')) {
      return options.stk ? options.stk() : jsonResponse({
        MerchantRequestID: 'merchant-1',
        CheckoutRequestID: 'ws_CO_123',
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing',
      });
    }
    if (url.includes('/stkpushquery/v1/query')) {
      return options.query ? options.query() : jsonResponse({ ResultCode: '0', ResultDesc: 'Success' });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}

test('mpesa: normalizes every Kenyan mobile format Safaricom accepts', () => {
  // Local, international and spaced forms all collapse to the 2547XXXXXXXX form.
  assert.equal(normalizeKenyanPhone('0752720933'), '254752720933');
  assert.equal(normalizeKenyanPhone('+254752720933'), '254752720933');
  assert.equal(normalizeKenyanPhone('254752720933'), '254752720933');
  assert.equal(normalizeKenyanPhone('0752 720 933'), '254752720933');
  assert.equal(normalizeKenyanPhone('0110000111'), '254110000111');
});

test('mpesa: refuses numbers that are not Kenyan mobile numbers', () => {
  for (const input of ['', '12345', '07527209', '+15552345678', '07527209331', 'not a number']) {
    assert.equal(normalizeKenyanPhone(input), null);
  }
});

test('mpesa: builds the STK timestamp in East Africa Time', () => {
  // 09:30:05 UTC is 12:30:05 in Nairobi.
  const utc = new Date(Date.UTC(2026, 10, 6, 9, 30, 5));
  assert.equal(buildStkTimestamp(utc), '20261106123005');
});

test('mpesa: builds the base64 STK password from shortcode, passkey and timestamp', () => {
  const expected = Buffer.from('174379passkey20261106123005').toString('base64');
  assert.equal(buildStkPassword('174379', 'passkey', '20261106123005'), expected);
});

test('mpesa: converts cents to whole shillings rounding up, never down', () => {
  assert.equal(amountKesFromCents(480000), 4800);
  assert.equal(amountKesFromCents(480001), 4801);
  assert.equal(amountKesFromCents(49), 1);
  assert.equal(amountKesFromCents(0), 0);
  assert.equal(amountKesFromCents(-100), 0);
});

test('mpesa: reads credentials from the environment and reports what is missing', () => {
  assert.equal(readMpesaConfig({}), null);

  const partial = readMpesaConfig({ MPESA_CONSUMER_KEY: 'k' });
  assert.equal(partial, null);

  const config = readMpesaConfig({
    MPESA_CONSUMER_KEY: 'key',
    MPESA_CONSUMER_SECRET: 'secret',
    MPESA_SHORTCODE: '174379',
    MPESA_PASSKEY: 'passkey',
    MPESA_CALLBACK_URL: 'https://example.test/cb',
    MPESA_ENVIRONMENT: 'Production',
  });
  assert.equal(config?.environment, 'production');
  assert.equal(config?.transactionType, 'CustomerPayBillOnline');
  assert.equal(config?.allowSimulated, false);
});

test('mpesa: STK push sends the documented Daraja payload and reuses the token', async () => {
  const { calls, fetchImpl } = transport({});
  const client = new DarajaClient(CONFIG, fetchImpl);

  const accepted = await client.requestStkPush({
    phone: '0752 720 933',
    amountKes: 4800,
    accountReference: 'ORD000123',
    description: 'Order ORD-000123',
  });

  assert.equal(accepted.checkoutRequestId, 'ws_CO_123');
  assert.equal(accepted.merchantRequestId, 'merchant-1');
  assert.equal(accepted.requestedAmountKes, 4800);

  const stkCall = calls.find((call) => call.url.includes('/stkpush/v1/processrequest'));
  assert.ok(stkCall);
  assert.equal(stkCall!.url, 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');

  const headers = stkCall!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer token-1');
  assert.equal(headers['Content-Type'], 'application/json');

  const body = JSON.parse(String(stkCall!.init?.body));
  assert.equal(body.BusinessShortCode, '174379');
  assert.equal(body.TransactionType, 'CustomerPayBillOnline');
  assert.equal(body.Amount, 4800);
  assert.equal(body.PartyA, '254752720933');
  assert.equal(body.PartyB, '174379');
  assert.equal(body.PhoneNumber, '254752720933');
  assert.equal(body.CallBackURL, CONFIG.callbackUrl);
  assert.equal(body.AccountReference, 'ORD000123');
  // Password must be shortcode + passkey + the same timestamp in the payload.
  assert.equal(body.Password, Buffer.from(`174379passkey${body.Timestamp}`).toString('base64'));

  // A second push must not re-authenticate.
  await client.requestStkPush({
    phone: '0752720933',
    amountKes: 100,
    accountReference: 'ORD000124',
    description: 'Order ORD-000124',
  });
  assert.equal(calls.filter((call) => call.url.includes('/oauth')).length, 1);
});

test('mpesa: a bad phone number is rejected before any network call', async () => {
  const { calls, fetchImpl } = transport({});
  const client = new DarajaClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.requestStkPush({ phone: '12345', amountKes: 100, accountReference: 'X', description: 'Y' }),
    MpesaRequestError
  );
  assert.equal(calls.length, 0);
});

test('mpesa: an HTTP failure or a non-zero ResponseCode becomes MpesaRequestError', async () => {
  const failing = transport({ stk: () => jsonResponse({ errorMessage: 'Bad Request' }, 400) });
  await assert.rejects(
    () => new DarajaClient(CONFIG, failing.fetchImpl).requestStkPush({
      phone: '0752720933', amountKes: 10, accountReference: 'X', description: 'Y',
    }),
    (error: unknown) => error instanceof MpesaRequestError && error.status === 400
  );

  const rejected = transport({ stk: () => jsonResponse({ ResponseCode: '1', ResponseDescription: 'Rejected' }) });
  await assert.rejects(
    () => new DarajaClient(CONFIG, rejected.fetchImpl).requestStkPush({
      phone: '0752720933', amountKes: 10, accountReference: 'X', description: 'Y',
    }),
    MpesaRequestError
  );
});

test('mpesa: parses a successful callback down to the receipt and amount', () => {
  const outcome = parseStkCallback({
    Body: {
      stkCallback: {
        MerchantRequestID: 'merchant-1',
        CheckoutRequestID: 'ws_CO_123',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 4800 },
            { Name: 'MpesaReceiptNumber', Value: 'QKD73HD892' },
            { Name: 'TransactionDate', Value: 20261106123105 },
            { Name: 'PhoneNumber', Value: 254752720933 },
          ],
        },
      },
    },
  });

  assert.equal(outcome.kind, 'PAID');
  if (outcome.kind === 'PAID') {
    assert.equal(outcome.receipt, 'QKD73HD892');
    assert.equal(outcome.amountKes, 4800);
    assert.equal(outcome.checkoutRequestId, 'ws_CO_123');
    assert.equal(outcome.phoneNumber, '254752720933');
  }
});

test('mpesa: parses a declined callback as a failure, not a payment', () => {
  const outcome = parseStkCallback({
    Body: {
      stkCallback: {
        CheckoutRequestID: 'ws_CO_123',
        ResultCode: 1032,
        ResultDesc: 'Request cancelled by user',
      },
    },
  });
  assert.equal(outcome.kind, 'FAILED');
  if (outcome.kind === 'FAILED') assert.equal(outcome.resultCode, 1032);
});

test('mpesa: a callback without a receipt is malformed rather than assumed paid', () => {
  for (const body of [
    {},
    { Body: {} },
    { Body: { stkCallback: { ResultCode: 0, CheckoutRequestID: 'ws_CO_1' } } },
    {
      Body: {
        stkCallback: {
          CheckoutRequestID: 'ws_CO_1',
          ResultCode: 0,
          CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100 }] },
        },
      },
    },
    {
      Body: {
        stkCallback: {
          CheckoutRequestID: 'ws_CO_1',
          ResultCode: 0,
          CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'QK1' }] },
        },
      },
    },
  ]) {
    assert.equal(parseStkCallback(body).kind, 'MALFORMED');
  }
});

test('mpesa: status query recognises a still-pending prompt', async () => {
  const { fetchImpl } = transport({
    query: () => jsonResponse({ ResultCode: '500.001.1001', ResultDesc: 'The transaction is being processed' }),
  });
  const pending = await new DarajaClient(CONFIG, fetchImpl).queryStkPush('ws_CO_123');
  assert.equal(pending.pending, true);
  assert.equal(pending.paid, false);

  const { fetchImpl: paidFetch } = transport({});
  const paid = await new DarajaClient(CONFIG, paidFetch).queryStkPush('ws_CO_123');
  assert.equal(paid.paid, true);
  assert.equal(paid.pending, false);
});
