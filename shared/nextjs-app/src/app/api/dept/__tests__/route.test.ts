import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  getCognitoUser: vi.fn(),
  listCognitoUsers: vi.fn(),
  requireFreshRole: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/aws-clients', () => ({ getCognitoUser: m.getCognitoUser, listCognitoUsers: m.listCognitoUsers }));
vi.mock('@/lib/role-admin', () => ({ requireFreshRole: m.requireFreshRole }));
vi.mock('@/lib/usage-client', () => ({ getUsageRecords: vi.fn(async () => []) }));
vi.mock('@aws-sdk/client-dynamodb', async (orig) => {
  const actual = await orig<typeof import('@aws-sdk/client-dynamodb')>();
  return { ...actual, DynamoDBClient: class { send = m.send; } };
});

import { getServerSession } from 'next-auth';
import * as route from '../route';

const asReq = (query = '') => ({ nextUrl: new URL(`http://x/api/dept${query}`) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  // Email domain "eng" would have been the old (spoofable) derivation.
  (getServerSession as any).mockResolvedValue({ user: { email: 'mgr@eng.com', groups: ['dept-manager'] } });
  m.requireFreshRole.mockResolvedValue({ ok: true, role: 'dept-manager' });
  m.getCognitoUser.mockResolvedValue({ department: 'research' });
  m.listCognitoUsers.mockResolvedValue([
    { username: 'a', email: 'a@x.com', department: 'research' },
    { username: 'b', email: 'b@x.com', department: 'eng' },
    { username: 'c', email: 'c@x.com', department: 'default' },
  ]);
  m.send.mockResolvedValue({});
});

describe('GET /api/dept', () => {
  it('scopes a manager to the fresh Cognito department', async () => {
    const res = await route.GET(asReq('?department=eng'));
    const body = await res.json();
    expect(body.data.department).toBe('research');
    expect(body.data.members.map((u: { email: string }) => u.email)).toEqual(['a@x.com']);
  });

  it('manager without a real department gets empty results', async () => {
    m.getCognitoUser.mockResolvedValue({ department: 'default' });
    const res = await route.GET(asReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.members).toEqual([]);
    expect(m.listCognitoUsers).not.toHaveBeenCalled();
  });

  it('deleted manager (UserNotFound) gets empty results, not 503', async () => {
    m.getCognitoUser.mockRejectedValue(Object.assign(new Error('gone'), { name: 'UserNotFoundException' }));
    const res = await route.GET(asReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data.members).toEqual([]);
  });

  it('other Cognito errors → 503', async () => {
    m.getCognitoUser.mockRejectedValue(new Error('throttled'));
    const res = await route.GET(asReq());
    expect(res.status).toBe(503);
  });

  it('admin keeps the ?department filter', async () => {
    m.requireFreshRole.mockResolvedValue({ ok: true, role: 'admin' });
    const res = await route.GET(asReq('?department=eng'));
    const body = await res.json();
    expect(body.data.department).toBe('eng');
    expect(m.getCognitoUser).not.toHaveBeenCalled();
  });

  it('no longer exposes the unauthenticated approve POST', () => {
    expect('POST' in route).toBe(false);
  });
});
