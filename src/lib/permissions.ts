/**
 * Role-Based Access Control (RBAC) & View Permissions for OmniCommerce AI
 * Enforces strict boundary segregation between Customer, Staff, and Business Owner.
 */

import type { UserRole } from './types.ts';

export type TabId =
  | 'storefront'
  | 'overview'
  | 'support'
  | 'inventory'
  | 'orders'
  | 'ai-sales'
  | 'ai-assistant'
  | 'whatsapp'
  | 'automation';

export interface RolePermissionConfig {
  allowedTabs: TabId[];
  canAdjustStock: boolean;
  canViewFinancialKpis: boolean;
  canTriggerConcurrencyTest: boolean;
  canManageIntegrations: boolean;
  canTransitionOrderToAdminStates: boolean;
  canViewInternalReservations: boolean;
}

export const ROLE_PERMISSIONS: Record<UserRole, RolePermissionConfig> = {
  CUSTOMER: {
    // Strictly limited to Storefront & Cart and public Inventory & Catalog
    allowedTabs: ['storefront', 'inventory'],
    canAdjustStock: false,
    canViewFinancialKpis: false,
    canTriggerConcurrencyTest: false,
    canManageIntegrations: false,
    canTransitionOrderToAdminStates: false,
    canViewInternalReservations: false,
  },
  BUSINESS_OWNER: {
    allowedTabs: [
      'overview',
      'support',
      'ai-sales',
      'whatsapp',
      'orders',
      'inventory',
      'storefront',
      'ai-assistant',
      'automation',
    ],
    canAdjustStock: true,
    canViewFinancialKpis: true,
    canTriggerConcurrencyTest: true,
    canManageIntegrations: true,
    canTransitionOrderToAdminStates: true,
    canViewInternalReservations: true,
  },
  SUPER_ADMIN: {
    allowedTabs: [
      'overview',
      'support',
      'ai-sales',
      'whatsapp',
      'orders',
      'inventory',
      'storefront',
      'ai-assistant',
      'automation',
    ],
    canAdjustStock: true,
    canViewFinancialKpis: true,
    canTriggerConcurrencyTest: true,
    canManageIntegrations: true,
    canTransitionOrderToAdminStates: true,
    canViewInternalReservations: true,
  },
  FULFILLMENT_STAFF: {
    // Has access to Fulfillment Operations AND Customer Dashboard/Storefront
    allowedTabs: ['overview', 'storefront', 'inventory', 'orders'],
    canAdjustStock: true,
    canViewFinancialKpis: false,
    canTriggerConcurrencyTest: false,
    canManageIntegrations: false,
    canTransitionOrderToAdminStates: true,
    canViewInternalReservations: true,
  },
  SUPPORT_STAFF: {
    // Has access to Support Desk AND WhatsApp, Orders, and Storefront
    allowedTabs: ['support', 'ai-sales', 'whatsapp', 'orders', 'storefront', 'ai-assistant'],
    canAdjustStock: false,
    canViewFinancialKpis: false,
    canTriggerConcurrencyTest: false,
    canManageIntegrations: false,
    canTransitionOrderToAdminStates: true,
    canViewInternalReservations: true,
  },
  SALES_STAFF: {
    allowedTabs: ['storefront', 'inventory', 'orders', 'ai-sales', 'ai-assistant'],
    canAdjustStock: false,
    canViewFinancialKpis: false,
    canTriggerConcurrencyTest: false,
    canManageIntegrations: false,
    canTransitionOrderToAdminStates: false,
    canViewInternalReservations: true,
  },
};

/**
 * Checks whether a given role is allowed to view a specific tab
 */
export function isTabPermitted(role: UserRole, tab: TabId): boolean {
  const config = ROLE_PERMISSIONS[role];
  if (!config) return false;
  return config.allowedTabs.includes(tab);
}

/**
 * Fallback to safe default tab if current tab is forbidden for role
 */
export function getSafeDefaultTab(role: UserRole, currentTab: TabId): TabId {
  const config = ROLE_PERMISSIONS[role];
  if (config && config.allowedTabs.includes(currentTab)) {
    return currentTab;
  }
  return config?.allowedTabs[0] || 'storefront';
}
