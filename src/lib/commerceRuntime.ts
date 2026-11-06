/**
 * Commerce Runtime - composition root for the stock/order source of truth.
 *
 * Everything else in the server talks to the `CommerceState` port. This module
 * is the single place that decides which adapter backs it, and the single place
 * that performs bootstrap seeding.
 *
 * Backend selection:
 *   COMMERCE_STATE_BACKEND=firestore (default) -> durable, transactional
 *   COMMERCE_STATE_BACKEND=memory              -> explicit local-development opt-in
 *
 * The memory adapter is never chosen implicitly. Silently degrading to
 * in-process state is how a deployed instance starts selling stock it does not
 * have, so a missing backend fails closed (503) rather than quietly.
 */

import {
  InMemoryCommerceState,
  createConversationStockPort,
  type CommerceState,
  type ConversationStockPort,
} from './commerceState.ts';
import { FirestoreCommerceState } from './firestoreCommerceState.ts';
import type { Product, WarehouseInventory } from './types.ts';

export type CommerceBackend = 'firestore' | 'memory';

export interface CommerceRuntime {
  readonly backend: CommerceBackend;
  readonly state: CommerceState;
  /** Idempotent: writes the catalogues only when the tenant has none. */
  seed(tenantId: string, inventory: WarehouseInventory[], products: Product[]): Promise<void>;
  /** Fresh availability snapshot per inbound message; reservations hit the store. */
  conversationStock(tenantId: string): Promise<ConversationStockPort>;
}

function resolveBackend(explicit?: CommerceBackend): CommerceBackend {
  if (explicit) return explicit;
  const configured = (process.env.COMMERCE_STATE_BACKEND || '').trim().toLowerCase();
  if (configured === 'memory') return 'memory';
  if (configured && configured !== 'firestore') {
    throw new Error(
      `COMMERCE_STATE_BACKEND must be "firestore" or "memory", received "${configured}".`
    );
  }
  return 'firestore';
}

export function createCommerceRuntime(options?: { backend?: CommerceBackend }): CommerceRuntime {
  const backend = resolveBackend(options?.backend);
  const state: CommerceState = backend === 'memory'
    ? new InMemoryCommerceState()
    : new FirestoreCommerceState();

  if (backend === 'memory') {
    console.warn(
      '[Commerce] COMMERCE_STATE_BACKEND=memory - stock and reservations live in this ' +
      'process only and are lost on restart. Do not use this outside local development.'
    );
  }

  return {
    backend,
    state,

    async seed(tenantId, inventory, products) {
      try {
        const seededInventory = await state.seedInventoryIfEmpty(tenantId, inventory);
        const seededProducts = await state.seedProductsIfEmpty(tenantId, products);
        if (seededInventory || seededProducts) {
          console.info(
            `[Commerce] Seeded tenant ${tenantId} ` +
            `(inventory: ${seededInventory ? inventory.length : 'existing'}, ` +
            `products: ${seededProducts ? products.length : 'existing'}).`
          );
        }
      } catch (error) {
        // Bootstrap must not take the process down: /health still needs to answer
        // so the platform can report the fault. Checkout fails closed instead.
        console.error(
          `[Commerce] Bootstrap seeding failed for tenant ${tenantId}:`,
          error instanceof Error ? error.message : error
        );
      }
    },

    async conversationStock(tenantId) {
      const rows = await state.listInventory(tenantId);
      return createConversationStockPort({
        tenantId,
        rows,
        reserve: (scopedTenantId, command) => state.reserve(scopedTenantId, command),
      });
    },
  };
}
