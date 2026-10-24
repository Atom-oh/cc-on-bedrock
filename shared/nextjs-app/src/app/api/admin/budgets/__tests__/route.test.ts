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
import { DeleteItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { PUT } from '../route';

const asReq = (body: unknown) => ({ json: async () => body } as never);
const sentOf = <T>(cls: new (...a: never[]) => T): T[] =>
  m.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);

beforeEach(() => {
  vi.clearAllMocks();
  (getServerSession as any).mockResolvedValue({ user: { isAdmin: true, email: 'Admin@x.com' } });
  m.requireFreshRole.mockResolvedValue({ ok: true, role: 'admin' });
  m.getCognitoUser.mockResolvedValue({ department: 'eng' });
  m.send.mockImplementation(async (c: unknown) =>
    c instanceof UpdateItemCommand ? { Attributes: { monthlyBudget: { N: '7' } } } : {}
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
    expect(unmarshall(sentOf(PutItemCommand)[0].input.Item!)).toMatchObject({
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
    const item = unmarshall(sentOf(PutItemCommand)[0].input.Item!);
    expect(item).toMatchObject({
      targetType: 'department',
      department: 'eng',
      before: { monthlyBudget: 7 },
      after: { monthlyBudget: 900, perUserDailyBudget: 3 },
    });
    expect(item.email).toBeUndefined();
  });
});
