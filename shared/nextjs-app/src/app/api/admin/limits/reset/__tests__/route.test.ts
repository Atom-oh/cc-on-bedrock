import { describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({ releaseTokenDeny: vi.fn(), requireFreshRole: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => ({ user: { isAdmin: true, email: 'a@x.com' } })) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/token-deny', () => ({ releaseTokenDeny: m.releaseTokenDeny, TokenDenyDetachError: class extends Error {} }));
vi.mock('@/lib/role-admin', () => ({ requireFreshRole: m.requireFreshRole }));

import { NextResponse } from 'next/server';
import { POST } from '../route';

describe('POST /api/admin/limits/reset', () => {
  it('stale admin session → 403 before any IAM/DynamoDB call', async () => {
    m.requireFreshRole.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const res = await POST({ json: async () => ({ email: 'u@x.com' }) } as never);
    expect(res.status).toBe(403);
    expect(m.requireFreshRole).toHaveBeenCalledWith(expect.anything(), ['admin']);
    expect(m.releaseTokenDeny).not.toHaveBeenCalled();
  });
});
