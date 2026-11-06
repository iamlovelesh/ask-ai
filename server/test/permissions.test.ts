import { describe, it, expect } from 'vitest';
import {
  canUseAction,
  permittedRisks,
  defaultPrincipal,
  resolvePrincipal,
  routeAgentForRole,
  type Principal,
} from '../src/agent/permissions';

const viewer: Principal = { userId: 'user_9', role: 'viewer' };
const member: Principal = { userId: 'user_9', role: 'member' };
const admin: Principal = { userId: 'user_1', role: 'admin' };

describe('permissions (#1)', () => {
  it('viewer may only use read actions', () => {
    expect(canUseAction(viewer, { risk: 'read' })).toBe(true);
    expect(canUseAction(viewer, { risk: 'write' })).toBe(false);
    expect(canUseAction(viewer, { risk: 'destructive' })).toBe(false);
    expect(canUseAction(viewer, { risk: 'bulk' })).toBe(false);
    expect(canUseAction(viewer, { risk: 'external' })).toBe(false);
  });

  it('member may read and write, but not destructive/bulk/external', () => {
    expect(canUseAction(member, { risk: 'read' })).toBe(true);
    expect(canUseAction(member, { risk: 'write' })).toBe(true);
    expect(canUseAction(member, { risk: 'destructive' })).toBe(false);
    expect(canUseAction(member, { risk: 'bulk' })).toBe(false);
    expect(canUseAction(member, { risk: 'external' })).toBe(false);
  });

  it('admin may use every risk class', () => {
    for (const risk of ['read', 'write', 'destructive', 'bulk', 'external'] as const) {
      expect(canUseAction(admin, { risk })).toBe(true);
    }
  });

  it('permittedRisks is monotonic viewer ⊂ member ⊂ admin', () => {
    const v = new Set(permittedRisks('viewer'));
    const m = new Set(permittedRisks('member'));
    const a = new Set(permittedRisks('admin'));
    for (const r of v) expect(m.has(r)).toBe(true);
    for (const r of m) expect(a.has(r)).toBe(true);
    expect(a.size).toBeGreaterThan(m.size);
    expect(m.size).toBeGreaterThan(v.size);
  });

  it('defaults to an admin principal (preserves pre-permission behavior)', () => {
    expect(defaultPrincipal().role).toBe('admin');
  });

  it('resolvePrincipal honors a known role and falls back to admin for unknown/empty', () => {
    expect(resolvePrincipal({ role: 'viewer' }).role).toBe('viewer');
    expect(resolvePrincipal({ role: 'member', userId: 'user_42' })).toEqual({ role: 'member', userId: 'user_42' });
    expect(resolvePrincipal({ role: 'root' }).role).toBe('admin'); // unknown -> safe default
    expect(resolvePrincipal(undefined).role).toBe('admin');
  });

  it('routes non-admin principals to the permission-aware "optimized" agent only', () => {
    // admin keeps whatever it asked for (unrestricted)
    expect(routeAgentForRole('admin', 'baseline')).toBe('baseline');
    expect(routeAgentForRole('admin', 'plandsl')).toBe('plandsl');
    // non-admin can never reach the un-pruned legacy paths
    expect(routeAgentForRole('member', 'baseline')).toBe('optimized');
    expect(routeAgentForRole('viewer', 'plandsl')).toBe('optimized');
    expect(routeAgentForRole('viewer', 'optimized')).toBe('optimized');
  });
});
