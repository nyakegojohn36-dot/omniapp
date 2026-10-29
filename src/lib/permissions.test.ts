import test from 'node:test';
import assert from 'node:assert/strict';
import { isTabPermitted, getSafeDefaultTab, ROLE_PERMISSIONS } from './permissions.ts';

test('Permissions: Customer can strictly only access Storefront and Inventory', () => {
  // Allowed
  assert.equal(isTabPermitted('CUSTOMER', 'storefront'), true);
  assert.equal(isTabPermitted('CUSTOMER', 'inventory'), true);

  // Forbidden
  assert.equal(isTabPermitted('CUSTOMER', 'overview'), false);
  assert.equal(isTabPermitted('CUSTOMER', 'orders'), false);
  assert.equal(isTabPermitted('CUSTOMER', 'ai-assistant'), false);
  assert.equal(isTabPermitted('CUSTOMER', 'whatsapp'), false);
  assert.equal(isTabPermitted('CUSTOMER', 'automation'), false);
});

test('Permissions: Customer has zero administrative capabilities', () => {
  const customerPerms = ROLE_PERMISSIONS.CUSTOMER;
  assert.equal(customerPerms.canAdjustStock, false);
  assert.equal(customerPerms.canViewFinancialKpis, false);
  assert.equal(customerPerms.canTriggerConcurrencyTest, false);
  assert.equal(customerPerms.canManageIntegrations, false);
  assert.equal(customerPerms.canViewInternalReservations, false);
});

test('Permissions: Business Owner has full platform capabilities', () => {
  const ownerPerms = ROLE_PERMISSIONS.BUSINESS_OWNER;
  assert.ok(ownerPerms.allowedTabs.length >= 7);
  assert.ok(ownerPerms.allowedTabs.includes('overview'));
  assert.equal(ownerPerms.canAdjustStock, true);
  assert.equal(ownerPerms.canViewFinancialKpis, true);
  assert.equal(ownerPerms.canTriggerConcurrencyTest, true);
});

test('Permissions: getSafeDefaultTab safely redirects forbidden tabs to permitted ones', () => {
  // If customer attempts to view 'overview' or 'automation', redirect to 'storefront'
  assert.equal(getSafeDefaultTab('CUSTOMER', 'overview'), 'storefront');
  assert.equal(getSafeDefaultTab('CUSTOMER', 'automation'), 'storefront');
  assert.equal(getSafeDefaultTab('CUSTOMER', 'orders'), 'storefront');

  // If already on a permitted tab, stay there
  assert.equal(getSafeDefaultTab('CUSTOMER', 'inventory'), 'inventory');
  assert.equal(getSafeDefaultTab('CUSTOMER', 'storefront'), 'storefront');
});

test('Permissions: Fulfillment Staff accesses Fulfillment Dashboard AND Customer Dashboard', () => {
  assert.equal(isTabPermitted('FULFILLMENT_STAFF', 'overview'), true);
  assert.equal(isTabPermitted('FULFILLMENT_STAFF', 'storefront'), true);
  assert.equal(isTabPermitted('FULFILLMENT_STAFF', 'inventory'), true);
  assert.equal(isTabPermitted('FULFILLMENT_STAFF', 'orders'), true);

  // Still blocked from Admin executive tools
  assert.equal(isTabPermitted('FULFILLMENT_STAFF', 'automation'), false);
  assert.equal(isTabPermitted('FULFILLMENT_STAFF', 'ai-assistant'), false);
  assert.equal(ROLE_PERMISSIONS.FULFILLMENT_STAFF.canViewFinancialKpis, false);
});
