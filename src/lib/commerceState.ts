/**
 * Durable Commerce State
 *
 * Single source of truth for stock, reservations, and the product catalogue.
 * Two adapters implement the same port:
 *   - InMemoryCommerceState  -> unit tests, local development without credentials
 *   - FirestoreCommerceState -> production, transactional (see firestoreCommerceState.ts)
 *
 * The reservation math lives here as pure functions so both adapters share one
 * implementation. A Firestore transaction applies the plan; the in-memory adapter
 * applies it under an async mutex. Neither adapter re-implements the rules.
 */

import type { Product, StockReservation, WarehouseInventory } from './types.ts';
import type { ReservationResult } from './inventoryEngine.ts';

/**
 * Raised when the durable store cannot answer, so the API returns 503 instead
 * of serving a second, in-process version of the truth.
 *
 * It lives in this leaf module rather than in firestoreCommerceState.ts because
 * firebaseAdmin.ts also needs it for order and return records: importing it from
 * the Firestore adapter would make the two modules import each other.
 */
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

export interface AvailabilitySnapshot {
  sku: string;
  physicalStock: number;
  reservedStock: number;
  quarantineStock: number;
  availableStock: number;
  isLowStock: boolean;
}

export interface ReserveStockCommand {
  orderId: string;
  sku: string;
  quantity: number;
  ttlMinutes?: number;
  warehouseId?: string;
}

export interface AdjustStockCommand {
  sku: string;
  warehouseId: string;
  physicalDelta: number;
  quarantineDelta: number;
  reason: string;
  actor: string;
}

export interface InventoryAdjustmentRecord {
  id: string;
  tenantId: string;
  sku: string;
  warehouseId: string;
  physicalDelta: number;
  quarantineDelta: number;
  reason: string;
  actor: string;
  createdAt: string;
}

export interface ReservationFilter {
  status?: StockReservation['status'];
  orderId?: string;
}

/**
 * Storage port. Every method is tenant-scoped: no call may read or write
 * another tenant's records.
 */
export interface CommerceState {
  listInventory(tenantId: string): Promise<WarehouseInventory[]>;
  getAvailability(tenantId: string, sku: string): Promise<AvailabilitySnapshot>;
  listReservations(tenantId: string, filter?: ReservationFilter): Promise<StockReservation[]>;
  reserve(tenantId: string, command: ReserveStockCommand): Promise<ReservationResult>;
  commit(tenantId: string, reservationId: string): Promise<boolean>;
  cancel(tenantId: string, reservationId: string): Promise<boolean>;
  releaseExpired(tenantId: string, options?: { sku?: string; limit?: number }): Promise<number>;
  adjust(tenantId: string, command: AdjustStockCommand): Promise<WarehouseInventory | null>;
  upsertInventory(tenantId: string, row: WarehouseInventory): Promise<void>;
  listAdjustments(tenantId: string, sku?: string): Promise<InventoryAdjustmentRecord[]>;

  listProducts(tenantId: string): Promise<Product[]>;
  upsertProduct(tenantId: string, product: Product): Promise<Product>;

  /** Idempotent bootstrap: writes the rows only when the tenant has none. */
  seedInventoryIfEmpty(tenantId: string, rows: WarehouseInventory[]): Promise<boolean>;
  seedProductsIfEmpty(tenantId: string, products: Product[]): Promise<boolean>;
}

/**
 * Narrow port handed to the conversational engine. Availability comes from a
 * snapshot read once per inbound message (cheap, eventually consistent);
 * reservation always goes back to the authoritative store.
 */
export interface ConversationStockPort {
  getAvailability(sku: string): AvailabilitySnapshot;
  reserveStock(command: ReserveStockCommand): Promise<ReservationResult>;
}

// ---------------------------------------------------------------------------
// Pure domain rules
// ---------------------------------------------------------------------------

const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/**
 * The single definition of what a shopper may buy.
 *
 * Everything that answers "how many are there?" - the aggregate snapshot, the
 * reservation planner, and the browser read model - goes through this, so the
 * three can never drift into disagreeing about the same shelf.
 */
export function computeAvailableStock(
  physicalStock: number,
  reservedStock: number,
  quarantineStock: number
): number {
  return Math.max(0, physicalStock - (reservedStock + quarantineStock));
}

/** available = max(0, physical - (reserved + quarantine)) aggregated across warehouses */
export function computeAvailability(rows: WarehouseInventory[], sku: string): AvailabilitySnapshot {
  let physical = 0;
  let reserved = 0;
  let quarantine = 0;
  let lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD;
  let matched = false;

  for (const row of rows) {
    if (row.sku !== sku) continue;
    matched = true;
    physical += row.physicalStock;
    reserved += row.reservedStock;
    quarantine += row.quarantineStock;
    // Deterministic across storage backends: the strictest threshold wins.
    lowStockThreshold = Math.min(lowStockThreshold, row.lowStockThreshold);
  }

  const available = computeAvailableStock(physical, reserved, quarantine);
  return {
    sku,
    physicalStock: physical,
    reservedStock: reserved,
    quarantineStock: quarantine,
    availableStock: available,
    isLowStock: matched && available > 0 && available <= lowStockThreshold,
  };
}

/**
 * Availability for every SKU present in the rows.
 * Used by the read API so the browser never recomputes stock from a stale copy.
 */
export function availabilityBySku(
  rows: WarehouseInventory[]
): Record<string, AvailabilitySnapshot> {
  const result: Record<string, AvailabilitySnapshot> = {};
  for (const sku of new Set(rows.map((row) => row.sku))) {
    result[sku] = computeAvailability(rows, sku);
  }
  return result;
}

export type ReserveFailureScenario =
  | 'OUT_OF_STOCK'
  | 'QUANTITY_EXCEEDED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'CONCURRENCY_CONFLICT';

export interface ReservePlan {
  /** Warehouse that will absorb the reservation. */
  warehouseId: string;
  /** Row after reservedStock has been incremented. */
  updatedRow: WarehouseInventory;
  totalAvailable: number;
}

export type PlanReservationResult =
  | { ok: true; plan: ReservePlan }
  | { ok: false; scenario: ReserveFailureScenario; availableStock: number; error: string };

/**
 * Decides whether a reservation is legal and which warehouse absorbs it.
 * Read-only: callers persist `plan.updatedRow` themselves, inside their own
 * atomic boundary.
 */
export function planReservation(
  rows: WarehouseInventory[],
  command: Pick<ReserveStockCommand, 'sku' | 'quantity' | 'warehouseId'>
): PlanReservationResult {
  const { sku, quantity, warehouseId } = command;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      scenario: 'QUANTITY_EXCEEDED',
      availableStock: 0,
      error: `Quantity must be a positive whole number, received ${quantity}.`,
    };
  }

  const matching = rows.filter(
    (row) => row.sku === sku && (!warehouseId || row.warehouseId === warehouseId)
  );

  if (matching.length === 0) {
    return {
      ok: false,
      scenario: 'WAREHOUSE_NOT_FOUND',
      availableStock: 0,
      error: `No warehouse records found for SKU ${sku}.`,
    };
  }

  const availabilityOf = (row: WarehouseInventory) =>
    computeAvailableStock(row.physicalStock, row.reservedStock, row.quarantineStock);

  const totalAvailable = matching.reduce((sum, row) => sum + availabilityOf(row), 0);

  if (totalAvailable <= 0) {
    return {
      ok: false,
      scenario: 'OUT_OF_STOCK',
      availableStock: 0,
      error: 'Item is completely out of stock.',
    };
  }

  if (quantity > totalAvailable) {
    return {
      ok: false,
      scenario: 'QUANTITY_EXCEEDED',
      availableStock: totalAvailable,
      error: `Requested ${quantity} units, but only ${totalAvailable} units are available.`,
    };
  }

  const target = matching.find((row) => availabilityOf(row) >= quantity) || matching[0];
  return {
    ok: true,
    plan: {
      warehouseId: target.warehouseId,
      updatedRow: { ...target, reservedStock: target.reservedStock + quantity },
      totalAvailable,
    },
  };
}

/** Commit: the units leave the building, so physical and reserved both drop. */
export function applyCommitToRow(row: WarehouseInventory, quantity: number): WarehouseInventory {
  return {
    ...row,
    physicalStock: Math.max(0, row.physicalStock - quantity),
    reservedStock: Math.max(0, row.reservedStock - quantity),
  };
}

/** Release (cancel or expiry): units return to availability, physical is untouched. */
export function applyReleaseToRow(row: WarehouseInventory, quantity: number): WarehouseInventory {
  return {
    ...row,
    reservedStock: Math.max(0, row.reservedStock - quantity),
  };
}

export function applyAdjustmentToRow(
  row: WarehouseInventory,
  physicalDelta: number,
  quarantineDelta: number
): WarehouseInventory {
  return {
    ...row,
    physicalStock: Math.max(0, row.physicalStock + physicalDelta),
    quarantineStock: Math.max(0, row.quarantineStock + quarantineDelta),
  };
}

function failure(
  scenario: ReserveFailureScenario,
  availableStock: number,
  error: string,
  requestedQuantity: number
): ReservationResult {
  return { success: false, availableStock, requestedQuantity, error, scenario };
}

export function isReservationExpired(reservation: StockReservation, now: number): boolean {
  return reservation.status === 'ACTIVE' && new Date(reservation.expiresAt).getTime() <= now;
}

export function sortReservationsChronologically(
  reservations: StockReservation[]
): StockReservation[] {
  return [...reservations].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

/**
 * Builds the per-message port handed to WhatsAppCloudService. Reads are served
 * from `rows`; writes go to the authoritative store.
 */
export function createConversationStockPort(options: {
  tenantId: string;
  rows: WarehouseInventory[];
  reserve: (tenantId: string, command: ReserveStockCommand) => Promise<ReservationResult>;
}): ConversationStockPort {
  const { tenantId, rows, reserve } = options;
  return {
    getAvailability: (sku: string) => computeAvailability(rows, sku),
    reserveStock: (command: ReserveStockCommand) => reserve(tenantId, command),
  };
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

interface TenantState {
  inventory: Map<string, WarehouseInventory>;
  reservations: Map<string, StockReservation>;
  products: Map<string, Product>;
  adjustments: InventoryAdjustmentRecord[];
}

function inventoryKey(sku: string, warehouseId: string): string {
  return `${sku}:${warehouseId}`;
}

/**
 * Used by unit tests and by local development without Firebase credentials.
 * Serializes mutations through a promise chain so concurrent callers observe
 * the same isolation a database transaction would give them.
 */
export class InMemoryCommerceState implements CommerceState {
  private tenants: Map<string, TenantState> = new Map();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(seed?: { tenantId: string; inventory?: WarehouseInventory[]; products?: Product[] }) {
    if (seed) {
      this.seedSync(seed.tenantId, seed.inventory || [], seed.products || []);
    }
  }

  private seedSync(tenantId: string, inventory: WarehouseInventory[], products: Product[]): void {
    const state = this.stateFor(tenantId);
    for (const row of inventory) {
      state.inventory.set(inventoryKey(row.sku, row.warehouseId), { ...row });
    }
    for (const product of products) {
      state.products.set(product.sku, { ...product });
    }
  }

  private stateFor(tenantId: string): TenantState {
    let state = this.tenants.get(tenantId);
    if (!state) {
      state = {
        inventory: new Map(),
        reservations: new Map(),
        products: new Map(),
        adjustments: [],
      };
      this.tenants.set(tenantId, state);
    }
    return state;
  }

  private runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const queued = this.chain.then(operation, operation);
    this.chain = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private rowsOf(state: TenantState): WarehouseInventory[] {
    return Array.from(state.inventory.values()).map((row) => ({ ...row }));
  }

  private releaseExpiredSync(state: TenantState, now: number, limit: number, sku?: string): number {
    const expired = sortReservationsChronologically(
      Array.from(state.reservations.values()).filter(
        (reservation) => isReservationExpired(reservation, now) && (!sku || reservation.sku === sku)
      )
    ).slice(0, limit);

    for (const reservation of expired) {
      const key = inventoryKey(reservation.sku, reservation.warehouseId);
      const row = state.inventory.get(key);
      if (row) {
        state.inventory.set(key, applyReleaseToRow(row, reservation.quantity));
      }
      state.reservations.set(reservation.id, { ...reservation, status: 'EXPIRED' });
    }
    return expired.length;
  }

  async listInventory(tenantId: string): Promise<WarehouseInventory[]> {
    return this.runExclusive(() => this.rowsOf(this.stateFor(tenantId)));
  }

  async getAvailability(tenantId: string, sku: string): Promise<AvailabilitySnapshot> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      this.releaseExpiredSync(state, Date.now(), Number.MAX_SAFE_INTEGER, sku);
      return computeAvailability(this.rowsOf(state), sku);
    });
  }

  async listReservations(tenantId: string, filter?: ReservationFilter): Promise<StockReservation[]> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      return Array.from(state.reservations.values())
        .filter((reservation) => !filter?.status || reservation.status === filter.status)
        .filter((reservation) => !filter?.orderId || reservation.orderId === filter.orderId)
        .map((reservation) => ({ ...reservation }));
    });
  }

  async reserve(tenantId: string, command: ReserveStockCommand): Promise<ReservationResult> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      const now = Date.now();
      // Expiry must be settled before the plan is computed, inside the same lock.
      this.releaseExpiredSync(state, now, Number.MAX_SAFE_INTEGER, command.sku);

      const plan = planReservation(this.rowsOf(state), command);
      if (!plan.ok) {
        return failure(plan.scenario, plan.availableStock, plan.error, command.quantity);
      }

      const { updatedRow, warehouseId, totalAvailable } = plan.plan;
      state.inventory.set(inventoryKey(updatedRow.sku, warehouseId), updatedRow);

      const ttlMinutes = command.ttlMinutes ?? 15;
      const reservation: StockReservation = {
        id: `res-${now}-${Math.random().toString(36).slice(2, 8)}`,
        tenantId,
        orderId: command.orderId,
        sku: command.sku,
        warehouseId,
        quantity: command.quantity,
        expiresAt: new Date(now + ttlMinutes * 60 * 1000).toISOString(),
        status: 'ACTIVE',
        createdAt: new Date(now).toISOString(),
      };
      state.reservations.set(reservation.id, reservation);

      return {
        success: true,
        reservation: { ...reservation },
        availableStock: totalAvailable - command.quantity,
        requestedQuantity: command.quantity,
        scenario: 'AVAILABLE',
      };
    });
  }

  async commit(tenantId: string, reservationId: string): Promise<boolean> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      const reservation = state.reservations.get(reservationId);
      if (!reservation || reservation.status !== 'ACTIVE') return false;

      const key = inventoryKey(reservation.sku, reservation.warehouseId);
      const row = state.inventory.get(key);
      if (!row) return false;

      state.inventory.set(key, applyCommitToRow(row, reservation.quantity));
      state.reservations.set(reservationId, { ...reservation, status: 'COMMITTED' });
      return true;
    });
  }

  async cancel(tenantId: string, reservationId: string): Promise<boolean> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      const reservation = state.reservations.get(reservationId);
      if (!reservation || reservation.status !== 'ACTIVE') return false;

      const key = inventoryKey(reservation.sku, reservation.warehouseId);
      const row = state.inventory.get(key);
      if (row) {
        state.inventory.set(key, applyReleaseToRow(row, reservation.quantity));
      }
      state.reservations.set(reservationId, { ...reservation, status: 'CANCELLED' });
      return true;
    });
  }

  async releaseExpired(
    tenantId: string,
    options?: { sku?: string; limit?: number }
  ): Promise<number> {
    return this.runExclusive(() =>
      this.releaseExpiredSync(
        this.stateFor(tenantId),
        Date.now(),
        options?.limit ?? Number.MAX_SAFE_INTEGER,
        options?.sku
      )
    );
  }

  async adjust(tenantId: string, command: AdjustStockCommand): Promise<WarehouseInventory | null> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      const key = inventoryKey(command.sku, command.warehouseId);
      const row = state.inventory.get(key);
      if (!row) return null;

      const updated = {
        ...applyAdjustmentToRow(row, command.physicalDelta, command.quarantineDelta),
        lastReconciledAt: new Date().toISOString(),
      };
      state.inventory.set(key, updated);
      state.adjustments.push({
        id: `adj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tenantId,
        sku: command.sku,
        warehouseId: command.warehouseId,
        physicalDelta: command.physicalDelta,
        quarantineDelta: command.quarantineDelta,
        reason: command.reason,
        actor: command.actor,
        createdAt: new Date().toISOString(),
      });
      return { ...updated };
    });
  }

  async upsertInventory(tenantId: string, row: WarehouseInventory): Promise<void> {
    return this.runExclusive(() => {
      this.stateFor(tenantId).inventory.set(inventoryKey(row.sku, row.warehouseId), { ...row });
    });
  }

  async listAdjustments(tenantId: string, sku?: string): Promise<InventoryAdjustmentRecord[]> {
    return this.runExclusive(() =>
      this.stateFor(tenantId)
        .adjustments.filter((record) => !sku || record.sku === sku)
        .map((record) => ({ ...record }))
    );
  }

  async listProducts(tenantId: string): Promise<Product[]> {
    return this.runExclusive(() =>
      Array.from(this.stateFor(tenantId).products.values()).map((product) => ({ ...product }))
    );
  }

  async upsertProduct(tenantId: string, product: Product): Promise<Product> {
    return this.runExclusive(() => {
      // Keyed by SKU, matching the Firestore adapter: one catalogue row per sellable SKU.
      this.stateFor(tenantId).products.set(product.sku, { ...product });
      return { ...product };
    });
  }

  async seedInventoryIfEmpty(tenantId: string, rows: WarehouseInventory[]): Promise<boolean> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      if (state.inventory.size > 0) return false;
      for (const row of rows) {
        state.inventory.set(inventoryKey(row.sku, row.warehouseId), { ...row });
      }
      return true;
    });
  }

  async seedProductsIfEmpty(tenantId: string, products: Product[]): Promise<boolean> {
    return this.runExclusive(() => {
      const state = this.stateFor(tenantId);
      if (state.products.size > 0) return false;
      for (const product of products) {
        state.products.set(product.sku, { ...product });
      }
      return true;
    });
  }
}
