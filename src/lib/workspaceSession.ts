import type { PendingBusinessWorkspace, Tenant, User } from './types.ts';

export interface WorkspaceSession {
  user: User;
  tenant: Tenant | null;
  pendingWorkspace: PendingBusinessWorkspace | null;
}

type SessionRequest = (path: string, init?: RequestInit) => Promise<Response>;

/** The only profile/workspace bootstrap path, used for sign-in and restoration. */
export async function loadWorkspaceSession(
  request: SessionRequest,
  requireEmailVerification = false
): Promise<WorkspaceSession> {
  async function read(path: string, init?: RequestInit) {
    const response = await request(path, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Session request failed (HTTP ${response.status}).`);
    return data;
  }
  let profile = await read('/api/auth/me');
  if (!profile.user) throw new Error('The server returned no account profile.');
  const draft = await read('/api/onboarding/business/pending');
  const pendingWorkspace = draft.pendingWorkspace as PendingBusinessWorkspace | null;
  if (!profile.user.emailVerified && (pendingWorkspace || requireEmailVerification || profile.requiresEmailVerification)) {
    return { user: profile.user, tenant: null, pendingWorkspace };
  }
  if (pendingWorkspace) {
    await read('/api/onboarding/business', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    // Read back the authoritative role, tenant and integration permissions after
    // provisioning; never reuse the customer profile from before the transaction.
    profile = await read('/api/auth/me');
    if (!profile.user) throw new Error('Could not reload the provisioned account.');
  }
  const workspace = await read('/api/tenant');
  if (!workspace.tenant || workspace.tenant.id !== profile.user.tenantId) {
    throw new Error('The account and workspace do not match. Please retry sign-in.');
  }
  return { user: profile.user, tenant: workspace.tenant, pendingWorkspace: null };
}

/** Ignore stale successes AND errors after sign-out, new sign-in or onboarding. */
export function createSessionCoordinator<Identity, Session>(
  load: (identity: Identity) => Promise<Session>,
  apply: (session: Session | null) => void,
  onError: (error: unknown) => void,
  onStart?: (identity: Identity | null) => void
) {
  let generation = 0;
  let suspended = false;
  async function restore(identity: Identity | null): Promise<void> {
    if (suspended) return;
    const ticket = ++generation;
    onStart?.(identity);
    if (!identity) { apply(null); return; }
    try {
      const session = await load(identity);
      if (ticket === generation) apply(session);
    } catch (error) {
      if (ticket === generation) onError(error);
    }
  }
  return {
    restore,
    suspend() { suspended = true; generation++; },
    resume(identity: Identity | null) { suspended = false; return restore(identity); },
    invalidate() { generation++; },
  };
}
