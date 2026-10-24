import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  getCognitoUser: vi.fn(),
  requireFreshRole: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/aws-clients', () => ({ getCognitoUser: m.getCognitoUser }));
vi.mock('@/lib/role-admin', () => ({ requireFreshRole: m.requireFreshRole }));
vi.mock('@aws-sdk/client-dynamodb', async (orig) => {
  const actual = await orig<typeof import('@aws-sdk/client-dynamodb')>();
  return { ...actual, DynamoDBClient: class { send = m.send; } };
});

import { getServerSession } from 'next-auth';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { PUT } from '../route';

const asReq = (body: unknown) => ({ json: async () => body } as never);
const departments: Record<string, string> = {
  'mgr@x.com': 'eng',
  'bob@x.com': 'eng',
  'eve@x.com': 'research',
  'nodept@x.com': 'default',
};
let deptMonthlyBudget = 0;

const sentOf = <T>(cls: new (...a: never[]) => T): T[] =>
  m.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);

beforeEach(() => {
  vi.clearAllMocks();
  deptMonthlyBudget = 0;
  (getServerSession as any).mockResolvedValue({ user: { email: 'mgr@x.com', department: 'stale-session-dept' } });
  m.requireFreshRole.mockResolvedValue({ ok: true, role: 'dept-manager' });
  m.getCognitoUser.mockImplementation(async (u: string) => {
    if (!(u in departments)) throw Object.assign(new Error('nope'), { name: 'UserNotFoundException' });
    return { email: u, department: departments[u] };
  });
  m.send.mockImplementation(async (c: unknown) => {
    if (c instanceof GetItemCommand) return { Item: { dept_id: { S: 'eng' }, monthlyBudget: { N: String(deptMonthlyBudget) } } };
    if (c instanceof UpdateItemCommand) return { Attributes: { monthlyBudget: { N: '10' }, updatedAt: { S: 'old' } } };
    return {};
  });
});

describe('PUT /api/dept/user-budgets', () => {
  it('manager sets a member limit: row update, LIMIT#monthly mirror, audit with department', async () => {
    const res = await PUT(asReq({ email: 'BOB@x.com', monthlyBudget: 50, dailyBudget: 5 }));
    expect(res.status).toBe(200);
    const [row, mirror] = sentOf(UpdateItemCommand);
    expect(row.input.Key).toEqual({ user_id: { S: 'bob@x.com' } });
    expect(row.input.ReturnValues).toBe('UPDATED_OLD');
    expect(mirror.input.Key).toEqual({ PK: { S: 'USER#bob@x.com' }, SK: { S: 'LIMIT#monthly' } });
    const [put] = sentOf(PutItemCommand);
    expect(unmarshall(put.input.Item!)).toMatchObject({
      type: 'limit_change',
      status: 'applied',
      actor: 'mgr@x.com',
      actorRole: 'dept-manager',
      email: 'bob@x.com',
      department: 'eng',
      before: { monthlyBudget: 10 },
      after: { dailyBudget: 5, monthlyBudget: 50 },
    });
  });

  it('monthly 0 deletes the mirror row', async () => {
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 0 }));
    expect(res.status).toBe(200);
    expect(sentOf(DeleteItemCommand)).toHaveLength(1);
  });

  it('uses the fresh Cognito department, not the session one', async () => {
    const res = await PUT(asReq({ email: 'eve@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('other_department');
    expect(m.send).not.toHaveBeenCalled();
  });

  it('manager cannot change their own limits', async () => {
    const res = await PUT(asReq({ email: 'mgr@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('self');
  });

  it('manager without a real department is refused', async () => {
    (getServerSession as any).mockResolvedValue({ user: { email: 'nodept@x.com' } });
    const res = await PUT(asReq({ email: 'bob@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('no_department');
    expect(m.send).not.toHaveBeenCalled();
  });

  it('monthly above the department total is refused', async () => {
    deptMonthlyBudget = 1000;
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 1200 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('exceeds_department_total');
    expect(sentOf(UpdateItemCommand)).toHaveLength(0);
  });

  it('rejects invalid values with invalid_limit', async () => {
    for (const v of [-1, 100001, 'x']) {
      const res = await PUT(asReq({ email: 'bob@x.com', weeklyBudget: v }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_limit');
    }
  });

  it('unknown target → 404', async () => {
    const res = await PUT(asReq({ email: 'ghost@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(404);
  });

  it('admin may change their own limits and is audited', async () => {
    (getServerSession as any).mockResolvedValue({ user: { email: 'bob@x.com' } });
    m.requireFreshRole.mockResolvedValue({ ok: true, role: 'admin' });
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 5000 }));
    expect(res.status).toBe(200);
    expect(sentOf(GetItemCommand)).toHaveLength(0);
    expect(unmarshall(sentOf(PutItemCommand)[0].input.Item!)).toMatchObject({ actor: 'bob@x.com', actorRole: 'admin' });
  });

  it('audit failure keeps the applied change and reports a warning', async () => {
    m.send.mockImplementation(async (c: unknown) => {
      if (c instanceof PutItemCommand) throw new Error('boom');
      return {};
    });
    const res = await PUT(asReq({ email: 'bob@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toBe('audit_failed');
  });
});
