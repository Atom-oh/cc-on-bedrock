import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getCognitoUser: vi.fn(),
  updateCognitoUser: vi.fn(),
  disableCognitoUser: vi.fn(),
  getRoleGroups: vi.fn(),
  countAdmins: vi.fn(),
  setUserRole: vi.fn(),
  requireFreshRole: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ec2-clients', () => ({ batchGetCustomRoutes: vi.fn() }));
vi.mock('@/lib/aws-clients', () => ({
  listCognitoUsers: vi.fn(),
  getCognitoUser: m.getCognitoUser,
  createCognitoUser: vi.fn(),
  updateCognitoUser: m.updateCognitoUser,
  deleteCognitoUser: vi.fn(),
  disableCognitoUser: m.disableCognitoUser,
  enableCognitoUser: vi.fn(),
  resetUserEnvironment: vi.fn(),
}));
vi.mock('@/lib/role-admin', () => ({
  getRoleGroups: m.getRoleGroups,
  countAdmins: m.countAdmins,
  setUserRole: m.setUserRole,
  requireFreshRole: m.requireFreshRole,
  listGroupMembers: vi.fn(),
}));

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { PUT } from '../route';

const asReq = (body: unknown) => ({ json: async () => body } as unknown as Request as never);
const target = { email: 'bob@x.com', department: 'eng', enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  m.setUserRole.mockReset();
  (getServerSession as any).mockResolvedValue({ user: { isAdmin: true, email: 'alice@x.com' } });
  m.requireFreshRole.mockResolvedValue({ ok: true, role: 'admin' });
  m.getCognitoUser.mockResolvedValue(target);
  m.countAdmins.mockResolvedValue(3);
});

describe('PUT /api/users role change', () => {
  it('does not call setUserRole when role is unchanged and no cleanup is needed', async () => {
    m.getRoleGroups.mockResolvedValue(['user']);
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'user' }));
    expect(res.status).toBe(200);
    expect(m.setUserRole).not.toHaveBeenCalled();
  });

  it('calls setUserRole to normalize a multi-group user even if the role is the same', async () => {
    m.getRoleGroups.mockResolvedValue(['admin', 'user']);
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'admin' }));
    expect(res.status).toBe(200);
    expect(m.setUserRole).toHaveBeenCalledWith('bob@x.com', 'admin');
  });

  it('returns 500 role_change_failed when setUserRole throws', async () => {
    m.getRoleGroups.mockResolvedValue(['user']);
    m.setUserRole.mockRejectedValue(new Error('boom'));
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'admin' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('role_change_failed');
  });

  it('returns the requireFreshRole response for a stale role', async () => {
    m.requireFreshRole.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Role changed — sign in again' }, { status: 403 }),
    });
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'admin' }));
    expect(res.status).toBe(403);
    expect(m.setUserRole).not.toHaveBeenCalled();
  });

  it('rejects dept-manager when the department is the placeholder "default"', async () => {
    m.getRoleGroups.mockResolvedValue(['user']);
    m.getCognitoUser.mockResolvedValue({ ...target, department: 'default' });
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'dept-manager' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('dept_required');
  });

  it('validates against the new department when sent with the role', async () => {
    m.getRoleGroups.mockResolvedValue(['user']);
    m.getCognitoUser.mockResolvedValue({ ...target, department: 'default' });
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'dept-manager', department: 'sales' }));
    expect(res.status).toBe(200);
    expect(m.setUserRole).toHaveBeenCalledWith('bob@x.com', 'dept-manager');
    expect(m.updateCognitoUser).toHaveBeenCalledWith({ username: 'bob@x.com', department: 'sales' });
  });
});

describe('PUT /api/users disable guards', () => {
  it('refuses disabling yourself', async () => {
    m.getCognitoUser.mockResolvedValue({ ...target, email: 'alice@x.com' });
    m.getRoleGroups.mockResolvedValue(['admin']);
    const res = await PUT(asReq({ username: 'alice@x.com', action: 'disable' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('self_demotion');
    expect(m.disableCognitoUser).not.toHaveBeenCalled();
  });

  it('refuses disabling the last enabled admin', async () => {
    m.getRoleGroups.mockResolvedValue(['admin']);
    m.countAdmins.mockResolvedValue(1);
    const res = await PUT(asReq({ username: 'bob@x.com', action: 'disable' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('last_admin');
  });

  it('allows demoting a disabled admin even when it is the only admin entry', async () => {
    m.getRoleGroups.mockResolvedValue(['admin']);
    m.getCognitoUser.mockResolvedValue({ ...target, enabled: false });
    m.countAdmins.mockResolvedValue(1);
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'user' }));
    expect(res.status).toBe(200);
    expect(m.setUserRole).toHaveBeenCalledWith('bob@x.com', 'user');
  });
});
