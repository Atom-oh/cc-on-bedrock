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
import { BatchGetItemCommand, GetItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { periodKey } from '@/lib/budget-grants';
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

  it('returns member limits, current grants and block cause for one department', async () => {
    const now = new Date();
    const day = periodKey('daily', now);
    const month = periodKey('monthly', now);
    m.send.mockImplementation(async (c: unknown) => {
      if (c instanceof GetItemCommand) {
        return { Item: marshall({ dept_id: 'research', monthlyBudget: 1000, currentSpend: 100, [`grant#monthly#${month}`]: 30 }) };
      }
      if (c instanceof BatchGetItemCommand) {
        return {
          Responses: {
            'cc-user-budgets': [
              marshall({ user_id: 'a@x.com', dailyBudget: 10, currentDailySpend: 12, [`grant#daily#${day}`]: 5, budgetExceeded: ['daily'] }),
            ],
          },
        };
      }
      if (c instanceof ScanCommand && c.input.TableName === 'cc-on-bedrock-limits') {
        return { Items: [marshall({ PK: 'USER#a@x.com' })] };
      }
      if (c instanceof ScanCommand) {
        return { Items: [marshall({ requestId: 'r1', type: 'budget_increase', period: 'daily', periodKey: day, requestedAmount: 7, email: 'a@x.com', status: 'pending', department: 'research' })] };
      }
      return {};
    });
    const res = await route.GET(asReq());
    const body = await res.json();
    expect(body.data.budget).toMatchObject({ monthlyBudget: 1000, recordedSpend: 100, monthGranted: 30 });
    const a = body.data.members[0];
    expect(a.limits).toEqual({ dailyBudget: 10, weeklyBudget: 0, monthlyBudget: 0 });
    expect(a.budgetStatus.periods.daily).toEqual({ spend: 12, base: 10, grant: 5, cap: 15 });
    expect(a.budgetStatus.tokenDenied).toBe(true);
    expect(a.budgetStatus.blockCause).toBe('user_daily');
    expect(body.data.pendingRequests[0]).toMatchObject({ type: 'budget_increase', period: 'daily', requestedAmount: 7 });
  });

  it('no longer exposes the unauthenticated approve POST', () => {
    expect('POST' in route).toBe(false);
  });
});
