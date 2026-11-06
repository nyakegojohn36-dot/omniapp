import { apiFetch } from './firebaseClient.ts';
import type { Order } from './types.ts';
import type { ReturnReason, ReturnRequest, ReturnStatus } from './returns.ts';

/**
 * Typed access to the returns API.
 *
 * The server owns every decision in this flow: it resolves which warehouse is
 * holding the goods, caps the claim at what was actually purchased, and moves
 * the stock. Nothing here computes a quantity or a refund amount, so a stale
 * browser tab can only ever *ask* for something and be refused.
 */

export interface ReturnMutationResult {
  order: Order;
  returnRequest: ReturnRequest;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');

  const response = await apiFetch(path, { ...init, headers });
  const raw = await response.text();

  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorField =
      body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    throw new Error(
      typeof errorField === 'string' && errorField.trim()
        ? errorField
        : `The returns service refused the request (HTTP ${response.status}).`
    );
  }

  return body as T;
}

export async function listReturns(status?: ReturnStatus): Promise<ReturnRequest[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const body = await request<{ returns?: ReturnRequest[] }>(`/api/returns${query}`);
  return body?.returns ?? [];
}

export interface RaiseReturnInput {
  orderId: string;
  /** Quantities only. The warehouse is resolved server-side from the original sale. */
  lines: { sku: string; quantity: number }[];
  reason: ReturnReason;
  note?: string;
}

export async function raiseReturn(input: RaiseReturnInput): Promise<ReturnMutationResult> {
  return request<ReturnMutationResult>('/api/returns', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function receiveReturnAtWarehouse(returnId: string): Promise<ReturnMutationResult> {
  return request<ReturnMutationResult>(`/api/returns/${encodeURIComponent(returnId)}/receive`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface InspectReturnInput {
  decision: 'APPROVE' | 'REJECT';
  /** Units fit to sell again, per SKU. Omit a SKU to restock all of it. */
  restock?: Record<string, number>;
  note?: string;
}

export async function inspectReturnAtWarehouse(
  returnId: string,
  input: InspectReturnInput
): Promise<ReturnMutationResult> {
  return request<ReturnMutationResult>(`/api/returns/${encodeURIComponent(returnId)}/inspect`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Records that the money left. The reference is the operator's proof that a
 * reversal happened in Daraja; this call does not move funds itself.
 */
export async function payRefund(
  returnId: string,
  refundReference: string
): Promise<ReturnMutationResult> {
  return request<ReturnMutationResult>(`/api/returns/${encodeURIComponent(returnId)}/refund`, {
    method: 'POST',
    body: JSON.stringify({ refundReference }),
  });
}
