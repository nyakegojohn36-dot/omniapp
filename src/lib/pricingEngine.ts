/**
 * Precision-Safe Financial & Pricing Engine
 * Computes order pricing in integer minor units (cents) to avoid floating-point drift.
 * Handles tax inclusive/exclusive configurations, multi-currency formatting, and discounts.
 */

export interface PricingInputItem {
  sku: string;
  unitPriceCents: number;
  quantity: number;
}

export interface CalculateOrderPricingParams {
  items: PricingInputItem[];
  currency: string;
  taxRatePercent: number; // e.g. 10 for 10%
  taxInclusive: boolean;
  shippingCountryCode: string;
  discountCode?: string;
}

export interface OrderPricingResult {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  formattedTotal: string;
  breakdown: {
    taxRatePercent: number;
    taxInclusive: boolean;
    appliedDiscount?: string;
  };
}

/**
 * Valid promotional discount vouchers
 */
export const VALID_DISCOUNTS: Record<
  string,
  { type: 'PERCENTAGE' | 'FIXED' | 'FREE_SHIPPING'; value: number }
> = {
  WELCOME10: { type: 'PERCENTAGE', value: 10 },
  SAVE20: { type: 'PERCENTAGE', value: 20 },
  FREESHIP: { type: 'FREE_SHIPPING', value: 0 },
};

/**
 * Standard shipping tiers by country code (in cents)
 */
export function getStandardShippingCents(
  countryCode: string,
  subtotalCents: number,
  currency = 'KES'
): number {
  if (currency === 'USD' || currency === 'EUR' || currency === 'GBP') {
    if (subtotalCents >= 10000) return 0;
    return 850;
  }
  if (subtotalCents >= 1000000) {
    // Free shipping in Kenya over KSh 10,000
    return 0;
  }
  switch (countryCode.toUpperCase()) {
    case 'KE':
      // Standard Nairobi Boda / Courier Delivery: KSh 300
      return 30000;
    case 'UG':
    case 'TZ':
    case 'RW':
      // East African Community Cross-Border Parcel: KSh 1,200
      return 120000;
    case 'US':
    case 'CA':
      return 250000;
    case 'GB':
    case 'EU':
      return 220000;
    default:
      return 50000; // Upcountry Kenya (Fargo / G4S Courier): KSh 500
  }
}

/**
 * Format currency amount cleanly with Kenyan Shilling (KSh) support
 */
export function formatCurrency(amountCents: number, currency = 'KES', locale = 'en-KE'): string {
  const decimalAmount = amountCents / 100;
  if (currency.toUpperCase() === 'KES') {
    return `KSh ${decimalAmount.toLocaleString('en-KE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(decimalAmount);
}

/**
 * Calculate complete immutable order pricing
 */
export function calculateOrderPricing(params: CalculateOrderPricingParams): OrderPricingResult {
  const {
    items,
    currency,
    taxRatePercent,
    taxInclusive,
    shippingCountryCode,
    discountCode,
  } = params;

  // 1. Subtotal calculation
  const subtotalCents = items.reduce((sum, item) => {
    return sum + item.unitPriceCents * item.quantity;
  }, 0);

  // 2. Discount calculation
  let discountCents = 0;
  let freeShippingApplied = false;

  if (discountCode) {
    const promo = VALID_DISCOUNTS[discountCode.trim().toUpperCase()];
    if (promo) {
      if (promo.type === 'PERCENTAGE') {
        discountCents = Math.round((subtotalCents * promo.value) / 100);
      } else if (promo.type === 'FIXED') {
        discountCents = Math.min(subtotalCents, promo.value);
      } else if (promo.type === 'FREE_SHIPPING') {
        freeShippingApplied = true;
      }
    }
  }

  const discountedSubtotal = Math.max(0, subtotalCents - discountCents);

  // 3. Shipping calculation
  let shippingCents = freeShippingApplied
    ? 0
    : getStandardShippingCents(shippingCountryCode, discountedSubtotal, currency);

  // 4. Tax calculation
  let taxCents = 0;
  if (taxInclusive) {
    // Price includes tax: Tax = Subtotal - (Subtotal / (1 + Rate))
    const taxFactor = 1 + taxRatePercent / 100;
    taxCents = Math.round(discountedSubtotal - discountedSubtotal / taxFactor);
  } else {
    // Price excludes tax: Tax = Subtotal * Rate
    taxCents = Math.round((discountedSubtotal * taxRatePercent) / 100);
  }

  // 5. Total calculation
  const totalCents = taxInclusive
    ? discountedSubtotal + shippingCents
    : discountedSubtotal + shippingCents + taxCents;

  return {
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents,
    currency,
    formattedTotal: formatCurrency(totalCents, currency),
    breakdown: {
      taxRatePercent,
      taxInclusive,
      appliedDiscount: discountCode,
    },
  };
}
