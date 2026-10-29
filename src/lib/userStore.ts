/**
 * Dynamic User & Role-Based Access Control Store
 * Enforces:
 * 1. All self-signups register strictly as CUSTOMER.
 * 2. Only the Business Owner / Admin can grant or revoke staff permissions.
 * 3. Changes persist across sessions in localStorage with fallback to SEED_USERS.
 */

import { SEED_USERS } from './sampleData.ts';
import type { User, UserRole } from './types.ts';

const STORAGE_KEY = 'omnicommerce_dynamic_users_kenya_v1';
const AUDIT_STORAGE_KEY = 'omnicommerce_rbac_audit_kenya_v1';

export interface RoleAuditRecord {
  id: string;
  timestamp: string;
  targetUserId: string;
  targetUserName: string;
  targetUserEmail: string;
  previousRole: UserRole;
  newRole: UserRole;
  grantedByUserId: string;
  grantedByUserName: string;
  reason?: string;
}

// In-memory cache when running in Node.js test environment or SSR
let memoryUsers: User[] = [...SEED_USERS];
let memoryAudit: RoleAuditRecord[] = [];

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * Retrieves the current dynamic list of users
 */
export function getDynamicUsers(tenantId?: string): User[] {
  if (isBrowser()) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as User[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          memoryUsers = parsed;
        }
      } else {
        // Initialize localStorage with seed users
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(SEED_USERS));
        memoryUsers = [...SEED_USERS];
      }
    } catch {
      // Fallback to in-memory if storage parse fails
    }
  }

  if (tenantId) {
    return memoryUsers.filter((u) => u.tenantId === tenantId || u.role === 'BUSINESS_OWNER');
  }
  return [...memoryUsers];
}

/**
 * Saves users into storage and memory
 */
export function saveDynamicUsers(users: User[]): void {
  memoryUsers = [...users];
  if (isBrowser()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
    } catch {
      // Storage full or unavailable
    }
  }
}

/**
 * Retrieves role permission audit history
 */
export function getRoleAuditHistory(): RoleAuditRecord[] {
  if (isBrowser()) {
    try {
      const raw = window.localStorage.getItem(AUDIT_STORAGE_KEY);
      if (raw) {
        memoryAudit = JSON.parse(raw);
      }
    } catch {
      // fallback
    }
  }
  return [...memoryAudit];
}

function recordRoleAudit(audit: RoleAuditRecord): void {
  memoryAudit = [audit, ...memoryAudit];
  if (isBrowser()) {
    try {
      window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(memoryAudit));
    } catch {
      // ignore
    }
  }
}

export interface SignUpCustomerParams {
  name: string;
  email: string;
  tenantId: string;
  phone?: string;
  password?: string;
}

export interface SignUpResult {
  success: boolean;
  user?: User;
  error?: string;
}

/**
 * Customer Self-Registration
 * Invariant: Every new registration defaults strictly to 'CUSTOMER'.
 * No user can self-select or grant themselves staff or admin permissions.
 */
export function signUpCustomer(params: SignUpCustomerParams): SignUpResult {
  const name = params.name?.trim();
  const email = params.email?.trim().toLowerCase();

  if (!name || name.length < 2) {
    return { success: false, error: 'Please enter a valid full name (at least 2 characters).' };
  }

  if (!email || !email.includes('@') || !email.includes('.')) {
    return { success: false, error: 'Please enter a valid email address.' };
  }

  const existingUsers = getDynamicUsers();
  const duplicate = existingUsers.find((u) => u.email.toLowerCase() === email);

  if (duplicate) {
    return {
      success: false,
      error: `An account with email "${email}" already exists. Please sign in instead.`,
    };
  }

  // Create new user strictly as CUSTOMER
  const newUser: User = {
    id: `usr-cust-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    tenantId: params.tenantId || 'tenant-nordic',
    name,
    email,
    role: 'CUSTOMER', // Strictly enforced default!
  };

  const updatedUsers = [newUser, ...existingUsers];
  saveDynamicUsers(updatedUsers);

  // Record initial audit log
  recordRoleAudit({
    id: `aud-reg-${Date.now()}`,
    timestamp: new Date().toISOString(),
    targetUserId: newUser.id,
    targetUserName: newUser.name,
    targetUserEmail: newUser.email,
    previousRole: 'CUSTOMER',
    newRole: 'CUSTOMER',
    grantedByUserId: newUser.id,
    grantedByUserName: 'Self-Registered Customer',
    reason: 'Initial public customer registration',
  });

  return { success: true, user: newUser };
}

export interface GrantRoleResult {
  success: boolean;
  updatedUser?: User;
  error?: string;
  auditRecord?: RoleAuditRecord;
}

/**
 * Grant or Revoke Permissions
 * Invariant: Only the BUSINESS_OWNER or SUPER_ADMIN can modify user roles.
 */
export function updateUserRole(
  actor: User,
  targetUserId: string,
  newRole: UserRole,
  reason?: string
): GrantRoleResult {
  // Authorization boundary check
  if (actor.role !== 'BUSINESS_OWNER' && actor.role !== 'SUPER_ADMIN') {
    return {
      success: false,
      error: 'Permission Denied: Only the Business Owner / Administrator can grant staff permissions.',
    };
  }

  const users = getDynamicUsers();
  const targetIndex = users.findIndex((u) => u.id === targetUserId);

  if (targetIndex === -1) {
    return { success: false, error: `User with ID "${targetUserId}" not found.` };
  }

  const target = users[targetIndex];
  const previousRole = target.role;

  if (previousRole === newRole) {
    return { success: true, updatedUser: target };
  }

  // Prevent demoting the last Business Owner
  if (previousRole === 'BUSINESS_OWNER' && newRole !== 'BUSINESS_OWNER') {
    const ownerCount = users.filter((u) => u.role === 'BUSINESS_OWNER').length;
    if (ownerCount <= 1) {
      return {
        success: false,
        error: 'Cannot demote the primary Business Owner account. At least one admin is required.',
      };
    }
  }

  const updatedTarget: User = {
    ...target,
    role: newRole,
  };

  users[targetIndex] = updatedTarget;
  saveDynamicUsers(users);

  const audit: RoleAuditRecord = {
    id: `aud-perm-${Date.now()}`,
    timestamp: new Date().toISOString(),
    targetUserId: target.id,
    targetUserName: target.name,
    targetUserEmail: target.email,
    previousRole,
    newRole,
    grantedByUserId: actor.id,
    grantedByUserName: actor.name,
    reason: reason || `Role updated from ${previousRole} to ${newRole} by Business Owner ${actor.name}`,
  };

  recordRoleAudit(audit);

  return {
    success: true,
    updatedUser: updatedTarget,
    auditRecord: audit,
  };
}

/**
 * Authenticates user against dynamic store
 */
export function authenticateUser(email: string, tenantId?: string): { success: boolean; user?: User; error?: string } {
  const users = getDynamicUsers(tenantId);
  const cleanEmail = email.trim().toLowerCase();
  const found = users.find((u) => u.email.toLowerCase() === cleanEmail);

  if (!found) {
    return {
      success: false,
      error: `No account found for "${email}". Please sign up as a new customer or check the email.`,
    };
  }

  return { success: true, user: found };
}

/**
 * Resets users back to initial seed data
 */
export function resetDynamicUsers(): User[] {
  saveDynamicUsers(SEED_USERS);
  memoryAudit = [];
  if (isBrowser()) {
    try {
      window.localStorage.removeItem(AUDIT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return [...SEED_USERS];
}
