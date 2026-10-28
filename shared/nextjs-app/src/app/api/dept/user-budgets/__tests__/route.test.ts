import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  getCognitoUser: vi.fn(),
  getRoleGroups: vi.fn(),
  requireFreshRole: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/aws-clients', () => ({ getCognitoUser: m.getCognitoUser }));
vi.mock('@/lib/role-admin', () => ({ requireFreshRole: m.requireFreshRole, getRoleGroups: m.getRoleGroups }));
vi.mock('@aws-sdk/client-dynamodb', async (orig) => {
  const actual = await orig<typeof import('@aws-sdk/client-dynamodb')>();
  return { ...actual, DynamoDBClient: class { send = m.send; } };
});

import { getServerSession } from 'next-auth';
import {
  DeleteItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { PUT } from '../route';

const asReq = (body: unknown) => ({ json: async () => body } as never);
const departments: Record<string, string> = {
  'mgr@x.com': 'eng',
  'bob@x.com': 'eng',
  'eve@x.com': 'research',
  'boss@x.com': 'eng',
  'nodept@x.com': 'default',
};
const roles: Record<string, string[]> = { 'boss@x.com': ['dept-manager'] };
let deptMonthlyBudget = 0;

const sentOf = <T>(cls: new (...a: never[]) => T): T[] =>
  m.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);
const writes = () => [...sentOf(TransactWriteItemsCommand), ...sentOf(UpdateItemCommand), ...sentOf(DeleteItemCommand)];

beforeEach(() => {
  vi.clearAllMocks();
  deptMonthlyBudget = 0;
  (getServerSession as any).mockResolvedValue({ user: { email: 'mgr@x.com', department: 'stale-session-dept' } });
  m.requireFreshRole.mockResolvedValue({ ok: true, role: 'dept-manager' });
  m.getCognitoUser.mockImplementation(async (u: string) => {
    if (!(u in departments)) throw Object.assign(new Error('nope'), { name: 'UserNotFoundException' });
    return { email: u, department: departments[u] };
  });
  m.getRoleGroups.mockImplementation(async (u: string) => roles[u] ?? ['user']);
  m.send.mockImplementation(async (c: unknown) => {
    if (c instanceof GetItemCommand) {
      return c.input.TableName === 'cc-department-budgets'
        ? { Item: { dept_id: { S: 'eng' }, monthlyBudget: { N: String(deptMonthlyBudget) } } }
        : { Item: { user_id: { S: 'bob@x.com' }, monthlyBudget: { N: '10' } } };
    }
    return {};
  });
});

describe('PUT /api/dept/user-budgets', () => {
  it('manager sets a member limit: row update + audit in one transaction, then the mirror', async () => {
    const res = await PUT(asReq({ email: 'BOB@x.com', monthlyBudget: 50, dailyBudget: 5 }));
    expect(res.status).toBe(200);
    const [tx] = sentOf(TransactWriteItemsCommand);
    const [rowUpdate, auditPut] = tx.input.TransactItems!;
    expect(rowUpdate.Update!.Key).toEqual({ user_id: { S: 'bob@x.com' } });
    expect(unmarshall(auditPut.Put!.Item!)).toMatchObject({
      type: 'limit_change',
      status: 'applied',
      actor: 'mgr@x.com',
      actorRole: 'dept-manager',
      email: 'bob@x.com',
      department: 'eng',
      before: { monthlyBudget: 10 },
      after: { dailyBudget: 5, monthlyBudget: 50 },
    });
    const [mirror] = sentOf(UpdateItemCommand);
    expect(mirror.input.Key).toEqual({ PK: { S: 'USER#bob@x.com' }, SK: { S: 'LIMIT#monthly' } });
    // the mirror runs after the transaction committed
    const order = m.send.mock.calls.map((c) => c[0]);
    expect(order.indexOf(mirror)).toBeGreaterThan(order.indexOf(tx));
  });

  it('monthly 0 deletes the mirror row', async () => {
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 0 }));
    expect(res.status).toBe(200);
    expect(sentOf(DeleteItemCommand)).toHaveLength(1);
  });

  it('a failed transaction writes nothing else and returns 500', async () => {
    m.send.mockImplementation(async (c: unknown) => {
      if (c instanceof TransactWriteItemsCommand) throw new Error('TransactionCanceledException');
      return {};
    });
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 20 }));
    expect(res.status).toBe(500);
    expect(sentOf(UpdateItemCommand)).toHaveLength(0);
  });

  it('uses the fresh Cognito department, not the session one', async () => {
    // Session says "research" (= target's department); fresh Cognito says "eng".
    (getServerSession as any).mockResolvedValue({ user: { email: 'mgr@x.com', department: 'research' } });
    const res = await PUT(asReq({ email: 'eve@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'other_department' });
    expect(writes()).toHaveLength(0);
  });

  it('manager cannot change their own limits', async () => {
    const res = await PUT(asReq({ email: 'mgr@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('self');
  });

  it('manager cannot change another manager in the department', async () => {
    const res = await PUT(asReq({ email: 'boss@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('target_is_manager');
    expect(writes()).toHaveLength(0);
  });

  it('target role lookup failure → 503 (fail closed)', async () => {
    m.getRoleGroups.mockRejectedValue(new Error('throttled'));
    const res = await PUT(asReq({ email: 'bob@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('Role check unavailable');
    expect(writes()).toHaveLength(0);
  });

  it('manager without a real department is refused', async () => {
    (getServerSession as any).mockResolvedValue({ user: { email: 'nodept@x.com' } });
    const res = await PUT(asReq({ email: 'bob@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('no_department');
    expect(m.send).not.toHaveBeenCalled();
  });

  it('deleted actor (UserNotFound) → 403, not 404', async () => {
    (getServerSession as any).mockResolvedValue({ user: { email: 'gone@x.com' } });
    const res = await PUT(asReq({ email: 'bob@x.com', dailyBudget: 5 }));
    expect(res.status).toBe(403);
  });

  it('monthly above the department total is refused with the total in the body', async () => {
    deptMonthlyBudget = 1000;
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 1200 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'exceeds_department_total', deptMonthlyBudget: 1000 });
    expect(writes()).toHaveLength(0);
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

  it('admin may change their own limits, skips the role lookup, and is audited', async () => {
    (getServerSession as any).mockResolvedValue({ user: { email: 'bob@x.com' } });
    m.requireFreshRole.mockResolvedValue({ ok: true, role: 'admin' });
    const res = await PUT(asReq({ email: 'bob@x.com', monthlyBudget: 5000 }));
    expect(res.status).toBe(200);
    expect(m.getRoleGroups).not.toHaveBeenCalled();
    const audit = unmarshall(sentOf(TransactWriteItemsCommand)[0].input.TransactItems![1].Put!.Item!);
    expect(audit).toMatchObject({ actor: 'bob@x.com', actorRole: 'admin' });
  });
});
