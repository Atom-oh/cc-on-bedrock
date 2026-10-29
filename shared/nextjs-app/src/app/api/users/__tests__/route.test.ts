import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  getCognitoUser: vi.fn(),
  updateCognitoUser: vi.fn(),
  disableCognitoUser: vi.fn(),
  getRoleGroups: vi.fn(),
  countAdmins: vi.fn(),
  setUserRole: vi.fn(),
  requireFreshRole: vi.fn(),
  listCognitoUsers: vi.fn(),
  listGroupMembers: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ec2-clients', () => ({ batchGetCustomRoutes: async () => new Map() }));
vi.mock('@/lib/aws-clients', () => ({
  listCognitoUsers: m.listCognitoUsers,
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
  listGroupMembers: m.listGroupMembers,
}));

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { GET, PUT } from '../route';

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

describe('shared user pool (COGNITO_GROUP_PREFIX set)', () => {
  beforeEach(() => vi.stubEnv('COGNITO_GROUP_PREFIX', 'cc-'));
  afterEach(() => vi.unstubAllEnvs());

  it('grants "user" to a user without any cc role group (setUserRole is called)', async () => {
    m.getRoleGroups.mockResolvedValue([]);
    const res = await PUT(asReq({ username: 'bob@x.com', role: 'user' }));
    expect(res.status).toBe(200);
    expect(m.setUserRole).toHaveBeenCalledWith('bob@x.com', 'user');
  });

  it('GET lists a user without a cc role group as role null (no access)', async () => {
    m.listCognitoUsers.mockResolvedValue([
      { username: 'u1', email: 'a@x.com', subdomain: '' },
      { username: 'u2', email: 'b@x.com', subdomain: '' },
    ]);
    m.listGroupMembers.mockImplementation(async (r: string) => (r === 'admin' ? [{ username: 'u1', email: 'a@x.com', enabled: true }] : []));
    const res = await GET({ url: 'https://x/api/users' } as never);
    const json = await res.json();
    expect(json.data.map((u: { username: string; role: string | null }) => [u.username, u.role])).toEqual([['u1', 'admin'], ['u2', null]]);
  });
});

describe('own user pool (no prefix)', () => {
  it('GET keeps defaulting a group-less user to "user"', async () => {
    m.listCognitoUsers.mockResolvedValue([{ username: 'u2', email: 'b@x.com', subdomain: '' }]);
    m.listGroupMembers.mockResolvedValue([]);
    const res = await GET({ url: 'https://x/api/users' } as never);
    expect((await res.json()).data[0].role).toBe('user');
  });
});
