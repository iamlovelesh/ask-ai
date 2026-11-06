/**
 * Principal-scoped permissions (#1, permission-pruned tools). Each
 * turn runs as a principal (user + role); the agent is only given the tools
 * that principal may use, and writes are attributed to them.
 *
 * This is a capability layer, not authentication — the demo has no login, so
 * the principal is resolved from the request (header/body) and defaults to an
 * admin, which exactly preserves pre-permission behavior (every tool bound).
 * The role→risk matrix is intentionally small and monotonic.
 */

import type { Risk } from '../catalog/types.js';

export type Role = 'admin' | 'member' | 'viewer';

export interface Principal {
  userId: string;
  role: Role;
}

const RISKS_BY_ROLE: Record<Role, readonly Risk[]> = {
  viewer: ['read'],
  member: ['read', 'write'],
  admin: ['read', 'write', 'destructive', 'bulk', 'external'],
};

export function permittedRisks(role: Role): readonly Risk[] {
  return RISKS_BY_ROLE[role];
}

/** Whether `principal` may use an action of the given risk class. */
export function canUseAction(principal: Principal, action: { risk: Risk }): boolean {
  return RISKS_BY_ROLE[principal.role].includes(action.risk);
}

const DEFAULT_USER_ID = 'user_1';

/** The default principal: admin, matching the single-tenant demo where every
 * tool was always bound. */
export function defaultPrincipal(): Principal {
  return { userId: DEFAULT_USER_ID, role: 'admin' };
}

function isRole(x: unknown): x is Role {
  return x === 'admin' || x === 'member' || x === 'viewer';
}

/** Resolve a (possibly partial/untrusted) principal spec to a concrete
 * Principal, falling back to the admin default for an unknown/empty role. */
export function resolvePrincipal(spec: { role?: unknown; userId?: unknown } | undefined): Principal {
  const base = defaultPrincipal();
  const role = isRole(spec?.role) ? spec.role : base.role;
  const userId = typeof spec?.userId === 'string' && spec.userId !== '' ? spec.userId : base.userId;
  return { userId, role };
}
