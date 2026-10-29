import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  getCognitoUser: vi.fn(),
  requireFreshRole: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/aws-clients', () => ({ getCognitoUser: m.getCognitoUser, listCognitoUsers: vi.fn() }));
vi.mock('@/lib/role-admin', () => ({ requireFreshRole: m.requireFreshRole }));
vi.mock('@aws-sdk/client-dynamodb', async (orig) => {
  const actual = await orig<typeof import('@aws-sdk/client-dynamodb')>();
  return { ...actual, DynamoDBClient: class { send = m.send; } };
});

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { DeleteItemCommand, GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { GET, PUT } from '../route';

const asReq = (body: unknown) => ({ json: async () => body } as never);
const sentOf = <T>(cls: new (...a: never[]) => T): T[] =>
  m.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);
const auditOf = (tx: TransactWriteItemsCommand) => unmarshall(tx.input.TransactItems![1].Put!.Item!);

beforeEach(() => {
  vi.clearAllMocks();
  (getServerSession as any).mockResolvedValue({ user: { isAdmin: true, email: 'Admin@x.com' } });
  m.requireFreshRole.mockResolvedValue({ ok: true, role: 'admin' });
  m.getCognitoUser.mockResolvedValue({ department: 'eng' });
  m.send.mockImplementation(async (c: unknown) =>
    c instanceof GetItemCommand ? { Item: { monthlyBudget: { N: '7' } } } : {}
  );
});

describe('PUT /api/admin/budgets', () => {
  it('re-checks the fresh admin role before writing', async () => {
    m.requireFreshRole.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Role changed — sign in again' }, { status: 403 }),
    });
    const res = await PUT(asReq({ type: 'user', id: 'bob@x.com', monthlyBudget: 5 }));
    expect(res.status).toBe(403);
    expect(m.requireFreshRole).toHaveBeenCalledWith(expect.anything(), ['admin']);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('user change keeps the LIMIT#monthly mirror and is audited (admin self included)', async () => {
    const res = await PUT(asReq({ type: 'user', id: 'Admin@x.com', monthlyBudget: 0 }));
    expect(res.status).toBe(200);
    expect(sentOf(DeleteItemCommand)[0].input.Key).toEqual({ PK: { S: 'USER#admin@x.com' }, SK: { S: 'LIMIT#monthly' } });
    const [tx] = sentOf(TransactWriteItemsCommand);
    expect(tx.input.TransactItems![0].Update!.Key).toEqual({ user_id: { S: 'admin@x.com' } });
    expect(auditOf(tx)).toMatchObject({
      type: 'limit_change',
      status: 'applied',
      actor: 'admin@x.com',
      targetType: 'user',
      email: 'admin@x.com',
      department: 'eng',
      before: { monthlyBudget: 7 },
      after: { monthlyBudget: 0 },
    });
  });

  it('department change is audited under that department without an email', async () => {
    const res = await PUT(asReq({ type: 'department', id: 'eng', monthlyBudget: 900, perUserDailyBudget: 3 }));
    expect(res.status).toBe(200);
    const [tx] = sentOf(TransactWriteItemsCommand);
    expect(tx.input.TransactItems![0].Update!.Key).toEqual({ dept_id: { S: 'eng' } });
    const item = auditOf(tx);
    expect(item).toMatchObject({
      targetType: 'department',
      department: 'eng',
      before: { monthlyBudget: 7 },
      after: { monthlyBudget: 900, perUserDailyBudget: 3 },
    });
    expect(item.email).toBeUndefined();
  });

  it('a failed transaction returns 500 and skips the mirror', async () => {
    m.send.mockImplementation(async (c: unknown) => {
      if (c instanceof TransactWriteItemsCommand) throw new Error('TransactionCanceledException');
      return {};
    });
    const res = await PUT(asReq({ type: 'user', id: 'bob@x.com', monthlyBudget: 5 }));
    expect(res.status).toBe(500);
    expect(sentOf(UpdateItemCommand)).toHaveLength(0);
    expect(sentOf(DeleteItemCommand)).toHaveLength(0);
  });
});

describe('PUT /api/admin/budgets unlimitedPerUser (dept)', () => {
  it('audits a row without the attribute as 0 on the first toggle', async () => {
    m.send.mockImplementation(async (c: unknown) => (c instanceof GetItemCommand ? { Item: { dept_id: { S: 'eng' } } } : {}));
    await PUT(asReq({ type: 'department', id: 'eng', unlimitedPerUser: true }));
    const [tx] = sentOf(TransactWriteItemsCommand);
    expect(auditOf(tx)).toMatchObject({ before: { unlimitedPerUser: 0 }, after: { unlimitedPerUser: 1 } });
  });

  it('writes the flag as a DynamoDB BOOL and accepts it as the only field', async () => {
    m.send.mockImplementation(async (c: unknown) =>
      c instanceof GetItemCommand ? { Item: { unlimitedPerUser: { BOOL: false } } } : {}
    );
    const res = await PUT(asReq({ type: 'department', id: 'eng', unlimitedPerUser: true }));
    expect(res.status).toBe(200);
    const [tx] = sentOf(TransactWriteItemsCommand);
    const update = tx.input.TransactItems![0].Update!;
    expect(update.UpdateExpression).toContain('unlimitedPerUser = :unlimitedPerUser');
    expect(update.ExpressionAttributeValues![':unlimitedPerUser']).toEqual({ BOOL: true });
    expect(auditOf(tx)).toMatchObject({
      targetType: 'department',
      before: { unlimitedPerUser: 0 },
      after: { unlimitedPerUser: 1 },
    });
  });

  it('rejects a non-boolean value', async () => {
    for (const v of ['true', 1, null]) {
      const res = await PUT(asReq({ type: 'department', id: 'eng', unlimitedPerUser: v }));
      expect(res.status).toBe(400);
    }
    expect(sentOf(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('rejects the flag on a user row', async () => {
    const res = await PUT(asReq({ type: 'user', id: 'bob@x.com', monthlyBudget: 5, unlimitedPerUser: true }));
    expect(res.status).toBe(400);
    expect(sentOf(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('still requires some field for a department', async () => {
    const res = await PUT(asReq({ type: 'department', id: 'eng' }));
    expect(res.status).toBe(400);
  });

  it('requires a fresh admin role', async () => {
    m.requireFreshRole.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Role changed — sign in again' }, { status: 403 }),
    });
    const res = await PUT(asReq({ type: 'department', id: 'eng', unlimitedPerUser: true }));
    expect(res.status).toBe(403);
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/budgets', () => {
  it('returns unlimitedPerUser for department rows (false when absent)', async () => {
    m.send.mockImplementation(async () => ({
      Items: [
        { dept_id: { S: 'eng' }, unlimitedPerUser: { BOOL: true } },
        { dept_id: { S: 'ops' } },
      ],
    }));
    const res = await GET({ url: 'https://x/api/admin/budgets?type=department' } as never);
    const json = await res.json();
    expect(json.data.departments.map((d: { department: string; unlimitedPerUser: boolean }) => [d.department, d.unlimitedPerUser]))
      .toEqual([['eng', true], ['ops', false]]);
  });
});
