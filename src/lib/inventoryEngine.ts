/**
 * Atomic Inventory & Reservation Concurrency Engine
 * Guarantees physical, available, and reserved stock consistency.
 * Prevents overselling, handles race conditions, reservation expiration (TTL), and discrepancies.
 */

import type { StockReservation, WarehouseInventory } from './types.ts';

export interface ReserveStockParams {
  tenantId: string;
  orderId: string;
  sku: string;
  warehouseId?: string;
  quantity: number;
  ttlMinutes?: number;
}

export interface ReservationResult {
  success: boolean;
  reservation?: StockReservation;
  availableStock: number;
  requestedQuantity: number;
  error?: string;
  scenario:
    | 'AVAILABLE'
    | 'OUT_OF_STOCK'
    | 'QUANTITY_EXCEEDED'
    | 'CONCURRENCY_CONFLICT'
    | 'WAREHOUSE_NOT_FOUND';
}

export class InventoryStore {
  private inventories: Map<string, WarehouseInventory> = new Map();
  private reservations: Map<string, StockReservation> = new Map();
  // Mutex locks for atomic operations per SKU
  private skuLocks: Map<string, boolean> = new Map();

  constructor(initialInventories?: WarehouseInventory[]) {
    if (initialInventories) {
      for (const inv of initialInventories) {
        this.inventories.set(`${inv.sku}:${inv.warehouseId}`, { ...inv });
      }
    }
  }

  private getKey(sku: string, warehouseId: string): string {
    return `${sku}:${warehouseId}`;
  }

  /**
   * Acquire atomic lock for SKU to prevent concurrent read-modify-write race conditions
   */
  private acquireLock(sku: string): boolean {
    if (this.skuLocks.get(sku)) {
      return false; // Lock contention
    }
    this.skuLocks.set(sku, true);
    return true;
  }

  private releaseLock(sku: string): void {
    this.skuLocks.delete(sku);
  }

  /**
   * Get total inventory view across warehouses for a SKU
   */
  public getAvailability(sku: string): {
    sku: string;
    physicalStock: number;
    reservedStock: number;
    quarantineStock: number;
    availableStock: number;
    isLowStock: boolean;
  } {
    this.cleanExpiredReservations();

    let physical = 0;
    let reserved = 0;
    let quarantine = 0;
    let lowStockThreshold = 5;

    for (const inv of this.inventories.values()) {
      if (inv.sku === sku) {
        physical += inv.physicalStock;
        reserved += inv.reservedStock;
        quarantine += inv.quarantineStock;
        lowStockThreshold = inv.lowStockThreshold;
      }
    }

    const available = Math.max(0, physical - (reserved + quarantine));
    return {
      sku,
      physicalStock: physical,
      reservedStock: reserved,
      quarantineStock: quarantine,
      availableStock: available,
      isLowStock: available <= lowStockThreshold && available > 0,
    };
  }

  /**
   * Atomic stock reservation with TTL
   */
  public reserveStock(params: ReserveStockParams): ReservationResult {
    const { tenantId, orderId, sku, quantity, ttlMinutes = 15 } = params;

    // Concurrency guard
    let lockAttempts = 0;
    while (!this.acquireLock(sku)) {
      lockAttempts++;
      if (lockAttempts > 10) {
        return {
          success: false,
          availableStock: 0,
          requestedQuantity: quantity,
          error: 'Concurrency conflict: SKU is under high reservation demand. Please retry.',
          scenario: 'CONCURRENCY_CONFLICT',
        };
      }
    }

    try {
      this.cleanExpiredReservations();

      // Find best warehouse (or specific warehouse)
      const matchingInventories = Array.from(this.inventories.values()).filter(
        (i) => i.sku === sku && (!params.warehouseId || i.warehouseId === params.warehouseId)
      );

      if (matchingInventories.length === 0) {
        return {
          success: false,
          availableStock: 0,
          requestedQuantity: quantity,
          error: `No warehouse records found for SKU ${sku}.`,
          scenario: 'WAREHOUSE_NOT_FOUND',
        };
      }

      // Calculate total available
      let totalAvailable = 0;
      for (const inv of matchingInventories) {
        const avail = Math.max(0, inv.physicalStock - (inv.reservedStock + inv.quarantineStock));
        totalAvailable += avail;
      }

      if (totalAvailable <= 0) {
        return {
          success: false,
          availableStock: 0,
          requestedQuantity: quantity,
          error: `Item is completely out of stock.`,
          scenario: 'OUT_OF_STOCK',
        };
      }

      if (quantity > totalAvailable) {
        return {
          success: false,
          availableStock: totalAvailable,
          requestedQuantity: quantity,
          error: `Requested ${quantity} units, but only ${totalAvailable} units are available.`,
          scenario: 'QUANTITY_EXCEEDED',
        };
      }

      // Allocate reservation to first warehouse with sufficient stock
      const targetWarehouse = matchingInventories.find((inv) => {
        const avail = inv.physicalStock - (inv.reservedStock + inv.quarantineStock);
        return avail >= quantity;
      }) || matchingInventories[0];

      // Update warehouse reserved count
      targetWarehouse.reservedStock += quantity;
      this.inventories.set(this.getKey(sku, targetWarehouse.warehouseId), targetWarehouse);

      // Create reservation record with expiration TTL
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const reservation: StockReservation = {
        id: reservationId,
        tenantId,
        orderId,
        sku,
        warehouseId: targetWarehouse.warehouseId,
        quantity,
        expiresAt,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      };

      this.reservations.set(reservationId, reservation);

      const remainingAvailable = totalAvailable - quantity;

      return {
        success: true,
        reservation,
        availableStock: remainingAvailable,
        requestedQuantity: quantity,
        scenario: 'AVAILABLE',
      };
    } finally {
      this.releaseLock(sku);
    }
  }

  /**
   * Commit reservation into final physical deduction when order is confirmed
   */
  public commitReservation(reservationId: string): boolean {
    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'ACTIVE') {
      return false;
    }

    const key = this.getKey(res.sku, res.warehouseId);
    const inv = this.inventories.get(key);
    if (!inv) return false;

    // Deduct physical and reserved atomically
    inv.physicalStock = Math.max(0, inv.physicalStock - res.quantity);
    inv.reservedStock = Math.max(0, inv.reservedStock - res.quantity);
    this.inventories.set(key, inv);

    res.status = 'COMMITTED';
    this.reservations.set(reservationId, res);
    return true;
  }

  /**
   * Cancel or release an active reservation
   */
  public cancelReservation(reservationId: string): boolean {
    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'ACTIVE') {
      return false;
    }

    const key = this.getKey(res.sku, res.warehouseId);
    const inv = this.inventories.get(key);
    if (inv) {
      inv.reservedStock = Math.max(0, inv.reservedStock - res.quantity);
      this.inventories.set(key, inv);
    }

    res.status = 'CANCELLED';
    this.reservations.set(reservationId, res);
    return true;
  }

  /**
   * Automatically release expired reservations whose TTL has lapsed
   */
  public cleanExpiredReservations(): number {
    const now = Date.now();
    let releasedCount = 0;

    for (const [id, res] of this.reservations.entries()) {
      if (res.status === 'ACTIVE' && new Date(res.expiresAt).getTime() <= now) {
        const key = this.getKey(res.sku, res.warehouseId);
        const inv = this.inventories.get(key);
        if (inv) {
          inv.reservedStock = Math.max(0, inv.reservedStock - res.quantity);
          this.inventories.set(key, inv);
        }
        res.status = 'EXPIRED';
        this.reservations.set(id, res);
        releasedCount++;
      }
    }

    return releasedCount;
  }

  /**
   * Record inventory adjustment or discrepancy
   */
  public recordAdjustment(
    sku: string,
    warehouseId: string,
    deltaPhysical: number,
    quarantineDelta: number,
    reason: string
  ): WarehouseInventory | null {
    const key = this.getKey(sku, warehouseId);
    let inv = this.inventories.get(key);
    if (!inv) return null;

    inv.physicalStock = Math.max(0, inv.physicalStock + deltaPhysical);
    inv.quarantineStock = Math.max(0, inv.quarantineStock + quarantineDelta);
    inv.lastReconciledAt = new Date().toISOString();
    this.inventories.set(key, inv);
    return { ...inv };
  }

  public addWarehouseInventory(inv: WarehouseInventory): void {
    const key = this.getKey(inv.sku, inv.warehouseId);
    this.inventories.set(key, { ...inv });
  }

  public getAllInventories(): WarehouseInventory[] {
    return Array.from(this.inventories.values()).map((i) => ({ ...i }));
  }

  public getAllReservations(): StockReservation[] {
    return Array.from(this.reservations.values()).map((r) => ({ ...r }));
  }
}
