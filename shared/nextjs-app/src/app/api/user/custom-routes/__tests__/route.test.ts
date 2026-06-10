import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getCustomRoutes, putCustomRoutes, mirrorCustomRoutes } = vi.hoisted(() => ({
  getCustomRoutes: vi.fn(),
  putCustomRoutes: vi.fn(),
  mirrorCustomRoutes: vi.fn(),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ec2-clients', () => ({ getCustomRoutes, putCustomRoutes }));
vi.mock('@/lib/aws-clients', () => ({ mirrorCustomRoutes }));

import { getServerSession } from 'next-auth';
import { GET, PUT } from '../route';

const asReq = (body?: unknown) =>
  ({ json: async () => body } as unknown as Request);

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/user/custom-routes', () => {
  it('401 when no session', async () => {
    (getServerSession as any).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });
  it('returns routes for own subdomain', async () => {
    (getServerSession as any).mockResolvedValue({ user: { subdomain: 'alice' } });
    getCustomRoutes.mockResolvedValue({ customRoutes: [{ path: '/p', port: 5000, label: 'x' }], routesVersion: 1 });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.routes).toHaveLength(1);
    expect(body.data.version).toBe(1);
  });
});

describe('PUT /api/user/custom-routes', () => {
  it('400 on invalid payload', async () => {
    (getServerSession as any).mockResolvedValue({ user: { subdomain: 'alice' } });
    const res = await PUT(asReq({ routes: [{ path: 'bad', port: 5000, label: 'x' }] }));
    expect(res.status).toBe(400);
  });
  it('rejects port 8080 with message', async () => {
    (getServerSession as any).mockResolvedValue({ user: { subdomain: 'alice' } });
    const res = await PUT(asReq({ routes: [{ path: '/x', port: 8080, label: 'x' }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('code-server');
  });
  it('persists and mirrors on valid payload', async () => {
    (getServerSession as any).mockResolvedValue({ user: { subdomain: 'alice' } });
    getCustomRoutes.mockResolvedValue({ customRoutes: [], routesVersion: 0, exists: true });
    putCustomRoutes.mockResolvedValue(1);
    mirrorCustomRoutes.mockResolvedValue({ mirrored: true });
    const res = await PUT(asReq({ routes: [{ path: '/p', port: 5000, label: 'x' }] }));
    expect(res.status).toBe(200);
    expect(putCustomRoutes).toHaveBeenCalledWith('alice', expect.any(Array), 0);
    expect(mirrorCustomRoutes).toHaveBeenCalled();
  });
  it('409 when no instance record exists (no phantom row)', async () => {
    (getServerSession as any).mockResolvedValue({ user: { subdomain: 'alice' } });
    getCustomRoutes.mockResolvedValue({ customRoutes: [], routesVersion: 0, exists: false });
    const res = await PUT(asReq({ routes: [{ path: '/p', port: 5000, label: 'x' }] }));
    expect(res.status).toBe(409);
    expect(putCustomRoutes).not.toHaveBeenCalled();
  });
  it('409 on version conflict', async () => {
    (getServerSession as any).mockResolvedValue({ user: { subdomain: 'alice' } });
    getCustomRoutes.mockResolvedValue({ customRoutes: [], routesVersion: 0, exists: true });
    putCustomRoutes.mockRejectedValue(new Error('version-conflict'));
    const res = await PUT(asReq({ routes: [{ path: '/p', port: 5000, label: 'x' }] }));
    expect(res.status).toBe(409);
  });
});
