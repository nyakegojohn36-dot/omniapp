import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signUpCustomer,
  updateUserRole,
  authenticateUser,
  getDynamicUsers,
  resetDynamicUsers,
} from './userStore.ts';
import type { User } from './types.ts';

test('userStore: self-registration strictly assigns CUSTOMER role', () => {
  resetDynamicUsers();

  const result = signUpCustomer({
    name: 'Emily Watson',
    email: 'emily.watson@testdomain.com',
    tenantId: 'tenant-nordic',
  });

  assert.equal(result.success, true);
  assert.ok(result.user);
  assert.equal(result.user?.role, 'CUSTOMER');
  assert.equal(result.user?.name, 'Emily Watson');
  assert.equal(result.user?.email, 'emily.watson@testdomain.com');

  // Verify it exists in dynamic user list
  const users = getDynamicUsers();
  const saved = users.find((u) => u.email === 'emily.watson@testdomain.com');
  assert.ok(saved);
  assert.equal(saved.role, 'CUSTOMER');
});

test('userStore: rejects duplicate email registrations', () => {
  resetDynamicUsers();

  signUpCustomer({
    name: 'John Doe',
    email: 'john.doe@testdomain.com',
    tenantId: 'tenant-nordic',
  });

  const duplicate = signUpCustomer({
    name: 'John Another',
    email: 'john.doe@testdomain.com',
    tenantId: 'tenant-nordic',
  });

  assert.equal(duplicate.success, false);
  assert.match(duplicate.error || '', /already exists/);
});

test('userStore: only BUSINESS_OWNER can grant permissions to customers', () => {
  resetDynamicUsers();

  // Register a new customer
  const reg = signUpCustomer({
    name: 'Robert Miller',
    email: 'robert.m@testdomain.com',
    tenantId: 'tenant-nordic',
  });
  assert.ok(reg.user);
  assert.equal(reg.user.role, 'CUSTOMER');

  // 1. Try promoting Robert using another customer as actor -> MUST FAIL
  const unauthorizedActor: User = {
    id: 'usr-fake-customer',
    name: 'Hacker Joe',
    email: 'joe@badactor.com',
    role: 'CUSTOMER',
    tenantId: 'tenant-nordic',
  };

  const hackAttempt = updateUserRole(
    unauthorizedActor,
    reg.user.id,
    'FULFILLMENT_STAFF'
  );
  assert.equal(hackAttempt.success, false);
  assert.match(hackAttempt.error || '', /Permission Denied/i);

  // Verify role was NOT modified
  const userCheck1 = getDynamicUsers().find((u) => u.id === reg.user!.id);
  assert.equal(userCheck1?.role, 'CUSTOMER');

  // 2. Try promoting Robert using staff as actor -> MUST ALSO FAIL
  const staffActor: User = {
    id: 'usr-fulfill-1',
    name: 'Marcus Vance',
    email: 'marcus.v@nordicpeak.com',
    role: 'FULFILLMENT_STAFF',
    tenantId: 'tenant-nordic',
  };
  const staffAttempt = updateUserRole(
    staffActor,
    reg.user.id,
    'SUPPORT_STAFF'
  );
  assert.equal(staffAttempt.success, false);

  // 3. Promote Robert using Business Owner (Alex Rivera) -> MUST SUCCEED
  const ownerActor: User = {
    id: 'usr-admin-1',
    name: 'Alex Rivera',
    email: 'alex@nordicpeak.com',
    role: 'BUSINESS_OWNER',
    tenantId: 'tenant-nordic',
  };

  const grantSuccess = updateUserRole(
    ownerActor,
    reg.user.id,
    'FULFILLMENT_STAFF',
    'Promoted to warehouse operations supervisor'
  );

  assert.equal(grantSuccess.success, true);
  assert.equal(grantSuccess.updatedUser?.role, 'FULFILLMENT_STAFF');
  assert.ok(grantSuccess.auditRecord);
  assert.equal(grantSuccess.auditRecord?.newRole, 'FULFILLMENT_STAFF');

  // Verify in store
  const userCheck2 = getDynamicUsers().find((u) => u.id === reg.user!.id);
  assert.equal(userCheck2?.role, 'FULFILLMENT_STAFF');
});

test('userStore: authenticateUser retrieves dynamically updated roles', () => {
  resetDynamicUsers();

  const reg = signUpCustomer({
    name: 'Alice Cooper',
    email: 'alice@rock.com',
    tenantId: 'tenant-nordic',
  });
  assert.ok(reg.user);

  // Check initial login
  const auth1 = authenticateUser('alice@rock.com');
  assert.equal(auth1.success, true);
  assert.equal(auth1.user?.role, 'CUSTOMER');

  // Admin promotes Alice to SUPPORT_STAFF
  const ownerActor: User = {
    id: 'usr-admin-1',
    name: 'Alex Rivera',
    email: 'alex@nordicpeak.com',
    role: 'BUSINESS_OWNER',
    tenantId: 'tenant-nordic',
  };

  updateUserRole(ownerActor, reg.user.id, 'SUPPORT_STAFF');

  // Check login now returns SUPPORT_STAFF
  const auth2 = authenticateUser('alice@rock.com');
  assert.equal(auth2.success, true);
  assert.equal(auth2.user?.role, 'SUPPORT_STAFF');
});
