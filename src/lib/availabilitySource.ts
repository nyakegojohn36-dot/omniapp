/**
 * Browser-side read model for stock.
 *
 * The browser used to own an `InventoryStore` seeded from the sample data, so it
 * showed and "verified" stock that only existed in the tab. It now receives the
 * rows from the server and derives availability from them with the same pure
 * function the server uses, so the two cannot drift.
 *
 * Reads are non-authoritative by design: they decide what to render, never
 * whether a sale may proceed. Only the server reserves.
 */

import { computeAvailability, type AvailabilitySnapshot } from './commerceState.ts';
import type { WarehouseInventory } from './types.ts';

export interface AvailabilityReader {
  getAvailability(sku: string): AvailabilitySnapshot;
}

/** What the API sends: one snapshot per SKU the tenant stocks. */
export type AvailabilityMap = Record<string, AvailabilitySnapshot>;

function emptySnapshot(sku: string): AvailabilitySnapshot {
  return {
    sku,
    physicalStock: 0,
    reservedStock: 0,
    quarantineStock: 0,
    availableStock: 0,
    isLowStock: false,
  };
}

/** Built from the server's summary. An unknown SKU is unavailable, never assumed in stock. */
export function availabilityFromMap(map: AvailabilityMap | undefined): AvailabilityReader {
  const stock = map || {};
  return {
    getAvailability: (sku: string) => stock[sku] || emptySnapshot(sku),
  };
}

export function availabilityFromRows(rows: WarehouseInventory[]): AvailabilityReader {
  return {
    getAvailability: (sku: string) => computeAvailability(rows, sku),
  };
}
