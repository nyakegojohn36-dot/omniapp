/**
 * Authoritative Order Lifecycle State Machine
 * Defines deterministic transitions, guards, business invariant rules, and audit logging.
 */

import type { Order, OrderAuditEntry, OrderStatus, UserRole } from './types.ts';

export interface TransitionContext {
  actor: string;
  actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT';
  reason: string;
  metadata?: Record<string, unknown>;
  paymentConfirmed?: boolean;
  trackingNumberProvided?: boolean;
  carrierProvided?: boolean;
  itemReceivedAtWarehouse?: boolean;
}

export interface TransitionResult {
  success: boolean;
  order: Order;
  error?: string;
}

/**
 * Permitted next states mapped from current state
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PENDING_CONFIRMATION', 'AWAITING_PAYMENT', 'CANCELLED'],
  PENDING_CONFIRMATION: ['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED'],
  AWAITING_PAYMENT: ['CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: ['AWAITING_PAYMENT', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLATION_REQUESTED', 'CANCELLED', 'ON_HOLD'],
  PROCESSING: ['READY_FOR_DISPATCH', 'CANCELLATION_REQUESTED', 'ON_HOLD', 'EXCEPTION_REVIEW'],
  READY_FOR_DISPATCH: ['SHIPPED', 'PARTIALLY_FULFILLED', 'ON_HOLD', 'EXCEPTION_REVIEW'],
  PARTIALLY_FULFILLED: ['SHIPPED', 'ON_HOLD', 'EXCEPTION_REVIEW'],
  SHIPPED: ['DELIVERED', 'RETURN_REQUESTED', 'EXCEPTION_REVIEW'],
  DELIVERED: ['RETURN_REQUESTED'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'CONFIRMED', 'PROCESSING'],
  CANCELLED: [], // Terminal
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED', 'EXCEPTION_REVIEW'],
  RETURNED: ['REFUND_PENDING', 'EXCEPTION_REVIEW'],
  REFUND_PENDING: ['REFUNDED', 'PARTIALLY_REFUNDED', 'EXCEPTION_REVIEW'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  REFUNDED: [], // Terminal
  ON_HOLD: ['CONFIRMED', 'PROCESSING', 'READY_FOR_DISPATCH', 'CANCELLED', 'EXCEPTION_REVIEW'],
  EXCEPTION_REVIEW: ['ON_HOLD', 'PROCESSING', 'READY_FOR_DISPATCH', 'CANCELLED', 'REFUND_PENDING'],
};

/**
 * Validates whether an order can transition to target status
 */
export function canTransitionOrder(
  currentStatus: OrderStatus,
  targetStatus: OrderStatus,
  context: TransitionContext,
  order: Order
): { allowed: boolean; reason?: string } {
  const allowedNext = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowedNext.includes(targetStatus)) {
    return {
      allowed: false,
      reason: `Illegal state transition from ${currentStatus} to ${targetStatus}. Permitted next states: [${allowedNext.join(', ')}]`,
    };
  }

  // Guard: Prepaid orders entering CONFIRMED must have verified payment
  if (targetStatus === 'CONFIRMED' && order.paymentMethod !== 'CASH_ON_DELIVERY') {
    if (!order.isPaid && !context.paymentConfirmed) {
      return {
        allowed: false,
        reason: 'Prepaid order cannot enter CONFIRMED status without verified payment confirmation.',
      };
    }
  }

  // Guard: SHIPPED status requires tracking number or carrier
  if (targetStatus === 'SHIPPED') {
    const hasCarrier = order.shippingCarrier || context.carrierProvided;
    const hasTracking = order.trackingNumber || context.trackingNumberProvided;
    if (!hasCarrier && !hasTracking) {
      return {
        allowed: false,
        reason: 'Order cannot transition to SHIPPED without a carrier or tracking reference.',
      };
    }
  }

  // Guard: RETURNED status requires physical receipt confirmation
  if (targetStatus === 'RETURNED' && !context.itemReceivedAtWarehouse) {
    return {
      allowed: false,
      reason: 'Order return cannot be marked as RETURNED until goods are physically inspected and received.',
    };
  }

  // Guard: Staff-only transitions
  const staffRestrictedTargets: OrderStatus[] = [
    'ON_HOLD',
    'EXCEPTION_REVIEW',
    'REFUND_PENDING',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
  ];
  if (
    staffRestrictedTargets.includes(targetStatus) &&
    context.actorRole === 'CUSTOMER'
  ) {
    return {
      allowed: false,
      reason: `Customers cannot directly transition orders to ${targetStatus}; requires staff review.`,
    };
  }

  return { allowed: true };
}

/**
 * Execute state transition and produce an immutable new Order with updated audit log
 */
export function transitionOrder(
  order: Order,
  targetStatus: OrderStatus,
  context: TransitionContext
): TransitionResult {
  const validation = canTransitionOrder(order.status, targetStatus, context, order);
  if (!validation.allowed) {
    return {
      success: false,
      order,
      error: validation.reason,
    };
  }

  const now = new Date().toISOString();
  const auditEntry: OrderAuditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now,
    fromStatus: order.status,
    toStatus: targetStatus,
    actor: context.actor,
    actorRole: context.actorRole,
    reason: context.reason,
    metadata: context.metadata,
  };

  const updatedOrder: Order = {
    ...order,
    status: targetStatus,
    isPaid: context.paymentConfirmed ?? order.isPaid,
    trackingNumber: (context.metadata?.trackingNumber as string) ?? order.trackingNumber,
    shippingCarrier: (context.metadata?.shippingCarrier as string) ?? order.shippingCarrier,
    auditTrail: [...order.auditTrail, auditEntry],
    updatedAt: now,
  };

  return {
    success: true,
    order: updatedOrder,
  };
}
