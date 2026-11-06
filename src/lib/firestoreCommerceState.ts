/**
 * Firestore-backed CommerceState (production adapter).
 *
 * Atomicity model:
 *   Every stock mutation runs inside `db.runTransaction`. Firestore takes an
 *   optimistic read lock on the documents it reads and retries the whole
 *   function on contention, so two concurrent reservations for the final unit
 *   cannot both commit - the second transaction re-reads the updated
 *   reservedStock and fails the availability check.
 *
 * Expiry model:
 *   Firestore's native TTL policy deletes documents but cannot restore
 *   reserved stock, so expiry is a *claim*: expired reservations are released
 *   inside the same transaction that observes them, and a background sweeper
 *   (server) keeps the persisted documents tidy.
 *
 * Failure model:
 *   This adapter fails closed. If Firestore is unreachable it throws
 *   CommerceStateUnavailableError so the API returns 503 instead of silently
 *   serving a second, in-memory version of the truth.
 */

import { createHash } from 'node:crypto';
import type { Firestore, Query, Transaction } from 'firebase-admin/firestore';
import { getFirestoreDb } from './firebaseAdmin.ts';
import type { Product, StockReservation, WarehouseInventory } from './types.ts';
import type { ReservationResult } from './inventoryEngine.ts';
import {
  applyAdjustmentToRow,
  applyCommitToRow,
  applyReleaseToRow,
  computeAvailability,
  isReservationExpired,
  planReservation,
  sortReservationsChronologically,
  type AdjustStockCommand,
  type AvailabilitySnapshot,
  type CommerceState,
  type InventoryAdjustmentRecord,
  type ReservationFilter,
  type ReserveStockCommand,
} from './commerceState.ts';

const INVENTORY = 'inventory';
const RESERVATIONS = 'inventoryReservations';
const ADJUSTMENTS = 'inventoryAdjustments';
const PRODUCTS = 'products';

const SWEEP_LIMIT = 20;

export class CommerceStateUnavailableError extends Error {
  // Declared explicitly (not as a parameter property) because Node's
  // --experimental-strip-types cannot parse TypeScript parameter properties.
  originalError?: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = 'CommerceStateUnavailableError';
    this.originalError = originalError;
  }
}

function docId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function inventoryDocId(tenantId: string, sku: string, warehouseId: string): string {
  return docId(`${tenantId}:${sku}:${warehouseId}`);
}

function reservationDocId(tenantId: string, reservationId: string): string {
  return docId(`${tenantId}:${reservationId}`);
}

function productDocId(tenantId: string, sku: string): string {
  return docId(`${tenantId}:sku:${sku}`);
}

interface InventoryRowWithRef {
  row: WarehouseInventory;
  id: string;
}

function toRow(id: string, data: Record<string, unknown>): WarehouseInventory {
  return {
    sku: String(data.sku ?? ''),
    warehouseId: String(data.warehouseId ?? ''),
    warehouseName: String(data.warehouseName ?? ''),
    physicalStock: Number(data.physicalStock ?? 0),
    reservedStock: Number(data.reservedStock ?? 0),
    quarantineStock: Number(data.quarantineStock ?? 0),
    lowStockThreshold: Number(data.lowStockThreshold ?? 5),
    lastReconciledAt: String(data.lastReconciledAt ?? new Date().toISOString()),
  };
}

function toReservation(id: string, data: Record<string, unknown>): StockReservation {
  return {
    id: String(data.id ?? id),
    tenantId: String(data.tenantId ?? ''),
    orderId: String(data.orderId ?? ''),
    sku: String(data.sku ?? ''),
    warehouseId: String(data.warehouseId ?? ''),
    quantity: Number(data.quantity ?? 0),
    expiresAt: String(data.expiresAt ?? ''),
    status: (data.status as StockReservation['status']) ?? 'ACTIVE',
    createdAt: String(data.createdAt ?? ''),
  };
}

export class FirestoreCommerceState implements CommerceState {
  private db: Firestore;

  constructor(db: Firestore = getFirestoreDb()) {
    this.db = db;
  }

  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CommerceStateUnavailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CommerceStateUnavailableError(
        `Commerce state operation "${operation}" failed: ${message}`,
        error
      );
    }
  }

  private inventoryQuery(tenantId: string, sku?: string): Query {
    const collection = this.db.collection(INVENTORY);
    return sku
      ? collection.where('tenantId', '==', tenantId).where('sku', '==', sku)
      : collection.where('tenantId', '==', tenantId);
  }

  private expiredReservationQuery(
    tenantId: string,
    nowIso: string,
    sku?: string,
    limit = SWEEP_LIMIT
  ): Query {
    const collection = this.db.collection(RESERVATIONS);
    const base = sku
      ? collection
          .where('tenantId', '==', tenantId)
          .where('sku', '==', sku)
          .where('status', '==', 'ACTIVE')
      : collection.where('tenantId', '==', tenantId).where('status', '==', 'ACTIVE');
    return base.where('expiresAt', '<=', nowIso).limit(limit);
  }

  /**
   * Read-side adjustment: expired reservations still hold `reservedStock` until
   * a sweep persists the release, so subtract them before reporting availability.
   */
  private async readInventoryRows(
    tenantId: string,
    sku?: string
  ): Promise<{ rows: InventoryRowWithRef[]; expired: StockReservation[] }> {
    const now = Date.now();
    const [inventorySnapshot, expiredSnapshot] = await Promise.all([
      this.inventoryQuery(tenantId, sku).get(),
      this.expiredReservationQuery(tenantId, new Date(now).toISOString(), sku).get(),
    ]);

    const expired = sortReservationsChronologically(
      expiredSnapshot.docs.map((doc) => toReservation(doc.id, doc.data()))
    ).filter((reservation) => isReservationExpired(reservation, now));

    const rows = inventorySnapshot.docs.map((doc) => ({
      id: doc.id,
      row: toRow(doc.id, doc.data()),
    }));

    for (const reservation of expired) {
      const target = rows.find((entry) => entry.row.sku === reservation.sku &&
        entry.row.warehouseId === reservation.warehouseId);
      if (target) {
        target.row = applyReleaseToRow(target.row, reservation.quantity);
      }
    }

    return { rows, expired };
  }

  async listInventory(tenantId: string): Promise<WarehouseInventory[]> {
    return this.guard('listInventory', async () => {
      const { rows } = await this.readInventoryRows(tenantId);
      return rows.map((entry) => ({ ...entry.row }));
    });
  }

  async getAvailability(tenantId: string, sku: string): Promise<AvailabilitySnapshot> {
    return this.guard('getAvailability', async () => {
      const { rows } = await this.readInventoryRows(tenantId, sku);
      return computeAvailability(rows.map((entry) => entry.row), sku);
    });
  }

  async listReservations(
    tenantId: string,
    filter?: ReservationFilter
  ): Promise<StockReservation[]> {
    return this.guard('listReservations', async () => {
      // Push the filters into the query so an order-scoped read (the lifecycle
      // reconcile) does not scan every reservation the tenant has ever made.
      let query: Query = this.db.collection(RESERVATIONS).where('tenantId', '==', tenantId);
      if (filter?.status) query = query.where('status', '==', filter.status);
      if (filter?.orderId) query = query.where('orderId', '==', filter.orderId);

      const snapshot = await query.get();
      return snapshot.docs.map((doc) => toReservation(doc.id, doc.data()));
    });
  }

  async reserve(tenantId: string, command: ReserveStockCommand): Promise<ReservationResult> {
    return this.guard('reserve', async () => {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const ttlMinutes = command.ttlMinutes ?? 15;

      return this.db.runTransaction(async (transaction: Transaction) => {
        // ---- reads (must all happen before any write) ----
        const expiredSnapshot = await transaction.get(
          this.expiredReservationQuery(tenantId, nowIso, command.sku)
        );
        const inventorySnapshot = await transaction.get(
          this.inventoryQuery(tenantId, command.sku)
        );

        const expired = sortReservationsChronologically(
          expiredSnapshot.docs.map((doc) => toReservation(doc.id, doc.data()))
        ).filter((reservation) => isReservationExpired(reservation, now));

        const rows = inventorySnapshot.docs.map((doc) => ({
          id: doc.id,
          row: toRow(doc.id, doc.data()),
        }));

        // Release what has lapsed, in memory, before planning the new reservation.
        for (const reservation of expired) {
          const target = rows.find(
            (entry) =>
              entry.row.sku === reservation.sku &&
              entry.row.warehouseId === reservation.warehouseId
          );
          if (target) {
            target.row = applyReleaseToRow(target.row, reservation.quantity);
          }
        }

        const plan = planReservation(
          rows.map((entry) => entry.row),
          command
        );

        if (!plan.ok) {
          return {
            success: false,
            availableStock: plan.availableStock,
            requestedQuantity: command.quantity,
            error: plan.error,
            scenario: plan.scenario,
          } as ReservationResult;
        }

        // ---- writes ----
        for (const reservation of expired) {
          transaction.update(this.db.collection(RESERVATIONS).doc(reservationDocId(tenantId, reservation.id)), {
            status: 'EXPIRED',
            releasedAt: nowIso,
          });
        }

        const targetEntry = rows.find(
          (entry) => entry.row.warehouseId === plan.plan.warehouseId &&
            entry.row.sku === command.sku
        );
        const rowRef = targetEntry
          ? this.db.collection(INVENTORY).doc(targetEntry.id)
          : this.db.collection(INVENTORY).doc(
              inventoryDocId(tenantId, command.sku, plan.plan.warehouseId)
            );

        transaction.set(
          rowRef,
          {
            ...plan.plan.updatedRow,
            tenantId,
            updatedAt: nowIso,
          },
          { merge: true }
        );

        const reservation: StockReservation = {
          id: `res-${now}-${Math.random().toString(36).slice(2, 8)}`,
          tenantId,
          orderId: command.orderId,
          sku: command.sku,
          warehouseId: plan.plan.warehouseId,
          quantity: command.quantity,
          expiresAt: new Date(now + ttlMinutes * 60 * 1000).toISOString(),
          status: 'ACTIVE',
          createdAt: nowIso,
        };

        transaction.create(
          this.db.collection(RESERVATIONS).doc(reservationDocId(tenantId, reservation.id)),
          { ...reservation }
        );

        return {
          success: true,
          reservation,
          availableStock: plan.plan.totalAvailable - command.quantity,
          requestedQuantity: command.quantity,
          scenario: 'AVAILABLE',
        } as ReservationResult;
      });
    });
  }

  async commit(tenantId: string, reservationId: string): Promise<boolean> {
    return this.guard('commit', async () => {
      const reservationRef = this.db
        .collection(RESERVATIONS)
        .doc(reservationDocId(tenantId, reservationId));

      return this.db.runTransaction(async (transaction) => {
        const reservationSnapshot = await transaction.get(reservationRef);
        if (!reservationSnapshot.exists) return false;

        const reservation = toReservation(reservationSnapshot.id, reservationSnapshot.data()!);
        if (reservation.status !== 'ACTIVE') return false;

        const rowRef = this.db
          .collection(INVENTORY)
          .doc(inventoryDocId(tenantId, reservation.sku, reservation.warehouseId));
        const rowSnapshot = await transaction.get(rowRef);
        if (!rowSnapshot.exists) return false;

        const row = toRow(rowSnapshot.id, rowSnapshot.data()!);
        const updated = applyCommitToRow(row, reservation.quantity);

        transaction.set(
          rowRef,
          { ...updated, tenantId, updatedAt: new Date().toISOString() },
          { merge: true }
        );
        transaction.update(reservationRef, {
          status: 'COMMITTED',
          committedAt: new Date().toISOString(),
        });
        return true;
      });
    });
  }

  async cancel(tenantId: string, reservationId: string): Promise<boolean> {
    return this.guard('cancel', async () => {
      const reservationRef = this.db
        .collection(RESERVATIONS)
        .doc(reservationDocId(tenantId, reservationId));

      return this.db.runTransaction(async (transaction) => {
        const reservationSnapshot = await transaction.get(reservationRef);
        if (!reservationSnapshot.exists) return false;

        const reservation = toReservation(reservationSnapshot.id, reservationSnapshot.data()!);
        if (reservation.status !== 'ACTIVE') return false;

        const rowRef = this.db
          .collection(INVENTORY)
          .doc(inventoryDocId(tenantId, reservation.sku, reservation.warehouseId));
        const rowSnapshot = await transaction.get(rowRef);

        if (rowSnapshot.exists) {
          const row = toRow(rowSnapshot.id, rowSnapshot.data()!);
          const updated = applyReleaseToRow(row, reservation.quantity);
          transaction.set(
            rowRef,
            { ...updated, tenantId, updatedAt: new Date().toISOString() },
            { merge: true }
          );
        }

        transaction.update(reservationRef, {
          status: 'CANCELLED',
          cancelledAt: new Date().toISOString(),
        });
        return true;
      });
    });
  }

  async releaseExpired(
    tenantId: string,
    options?: { sku?: string; limit?: number }
  ): Promise<number> {
    return this.guard('releaseExpired', async () => {
      const limit = options?.limit ?? 200;
      const snapshot = await this.expiredReservationQuery(
        tenantId,
        new Date().toISOString(),
        options?.sku,
        limit
      ).get();

      if (snapshot.empty) return 0;

      const bySku = new Map<string, StockReservation[]>();
      for (const doc of snapshot.docs) {
        const reservation = toReservation(doc.id, doc.data());
        const bucket = bySku.get(reservation.sku) || [];
        bucket.push(reservation);
        bySku.set(reservation.sku, bucket);
      }

      let released = 0;
      for (const [sku, reservations] of bySku) {
        released += await this.releaseSkuBatch(tenantId, sku, reservations.slice(0, limit));
      }
      return released;
    });
  }

  private async releaseSkuBatch(
    tenantId: string,
    sku: string,
    expired: StockReservation[]
  ): Promise<number> {
    if (expired.length === 0) return 0;
    const nowIso = new Date().toISOString();

    return this.db.runTransaction(async (transaction) => {
      const inventorySnapshot = await transaction.get(this.inventoryQuery(tenantId, sku));
      const rows = inventorySnapshot.docs.map((doc) => ({
        id: doc.id,
        row: toRow(doc.id, doc.data()),
      }));

      let released = 0;
      for (const reservation of expired) {
        const target = rows.find(
          (entry) =>
            entry.row.sku === reservation.sku &&
            entry.row.warehouseId === reservation.warehouseId
        );
        if (target) {
          target.row = applyReleaseToRow(target.row, reservation.quantity);
        }
        released++;
      }

      for (const entry of rows) {
        transaction.set(
          this.db.collection(INVENTORY).doc(entry.id),
          { ...entry.row, tenantId, updatedAt: nowIso },
          { merge: true }
        );
      }

      for (const reservation of expired) {
        transaction.update(
          this.db.collection(RESERVATIONS).doc(reservationDocId(tenantId, reservation.id)),
          { status: 'EXPIRED', releasedAt: nowIso }
        );
      }

      return released;
    });
  }

  async adjust(tenantId: string, command: AdjustStockCommand): Promise<WarehouseInventory | null> {
    return this.guard('adjust', async () => {
      const nowIso = new Date().toISOString();
      const rowRef = this.db
        .collection(INVENTORY)
        .doc(inventoryDocId(tenantId, command.sku, command.warehouseId));

      return this.db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(rowRef);
        if (!snapshot.exists) return null;

        const row = toRow(snapshot.id, snapshot.data()!);
        const updated = {
          ...applyAdjustmentToRow(row, command.physicalDelta, command.quarantineDelta),
          lastReconciledAt: nowIso,
        };

        transaction.set(rowRef, { ...updated, tenantId, updatedAt: nowIso }, { merge: true });
        // Adjustment trail: who moved stock, by how much, and why.
        transaction.create(this.db.collection(ADJUSTMENTS).doc(), {
          tenantId,
          sku: command.sku,
          warehouseId: command.warehouseId,
          physicalDelta: command.physicalDelta,
          quarantineDelta: command.quarantineDelta,
          reason: command.reason,
          actor: command.actor,
          createdAt: nowIso,
        });

        return { ...updated };
      });
    });
  }

  async upsertInventory(tenantId: string, row: WarehouseInventory): Promise<void> {
    return this.guard('upsertInventory', async () => {
      await this.db
        .collection(INVENTORY)
        .doc(inventoryDocId(tenantId, row.sku, row.warehouseId))
        .set({ ...row, tenantId, updatedAt: new Date().toISOString() }, { merge: true });
    });
  }

  async listAdjustments(tenantId: string, sku?: string): Promise<InventoryAdjustmentRecord[]> {
    return this.guard('listAdjustments', async () => {
      const snapshot = await this.db
        .collection(ADJUSTMENTS)
        .where('tenantId', '==', tenantId)
        .get();
      return snapshot.docs
        .map((doc) => ({ id: doc.id, ...(doc.data() as Omit<InventoryAdjustmentRecord, 'id'>) }))
        .filter((record) => !sku || record.sku === sku)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async listProducts(tenantId: string): Promise<Product[]> {
    return this.guard('listProducts', async () => {
      const snapshot = await this.db
        .collection(PRODUCTS)
        .where('tenantId', '==', tenantId)
        .get();
      return snapshot.docs.map((doc) => doc.data().product as Product);
    });
  }

  /**
   * Keyed by SKU (not by generated id) so a retried create cannot produce two
   * catalogue rows for the same sellable item.
   */
  async upsertProduct(tenantId: string, product: Product): Promise<Product> {
    return this.guard('upsertProduct', async () => {
      const ref = this.db.collection(PRODUCTS).doc(productDocId(tenantId, product.sku));
      await ref.set(
        { tenantId, sku: product.sku, product, updatedAt: new Date().toISOString() },
        { merge: true }
      );
      return product;
    });
  }

  async seedInventoryIfEmpty(tenantId: string, rows: WarehouseInventory[]): Promise<boolean> {
    return this.guard('seedInventoryIfEmpty', async () => {
      if (rows.length === 0) return false;
      const existing = await this.inventoryQuery(tenantId).limit(1).get();
      if (!existing.empty) return false;

      const nowIso = new Date().toISOString();
      for (let offset = 0; offset < rows.length; offset += 400) {
        const batch = this.db.batch();
        for (const row of rows.slice(offset, offset + 400)) {
          batch.set(
            this.db.collection(INVENTORY).doc(
              inventoryDocId(tenantId, row.sku, row.warehouseId)
            ),
            { ...row, tenantId, updatedAt: nowIso }
          );
        }
        await batch.commit();
      }
      return true;
    });
  }

  async seedProductsIfEmpty(tenantId: string, products: Product[]): Promise<boolean> {
    return this.guard('seedProductsIfEmpty', async () => {
      if (products.length === 0) return false;
      const existing = await this.db.collection(PRODUCTS).where('tenantId', '==', tenantId).limit(1).get();
      if (!existing.empty) return false;

      const nowIso = new Date().toISOString();
      for (let offset = 0; offset < products.length; offset += 400) {
        const batch = this.db.batch();
        for (const product of products.slice(offset, offset + 400)) {
          batch.set(
            this.db.collection(PRODUCTS).doc(productDocId(tenantId, product.sku)),
            { tenantId, sku: product.sku, product, updatedAt: nowIso }
          );
        }
        await batch.commit();
      }
      return true;
    });
  }
}
