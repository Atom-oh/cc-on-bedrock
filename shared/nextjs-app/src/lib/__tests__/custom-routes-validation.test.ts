import { describe, it, expect } from 'vitest';
import {
  customRouteSchema,
  customRoutesPayloadSchema,
  RESERVED_PATHS,
  RESERVED_PORTS,
  MAX_CUSTOM_ROUTES,
  isReservedPath,
} from '../validation';

describe('RESERVED constants', () => {
  it('reserves only code-server port 8080', () => {
    expect([...RESERVED_PORTS]).toEqual([8080]);
  });
  it('does not reserve 3000/8000 (now seedable custom ports)', () => {
    expect(RESERVED_PORTS).not.toContain(3000);
    expect(RESERVED_PORTS).not.toContain(8000);
  });
  it('MAX is 5', () => { expect(MAX_CUSTOM_ROUTES).toBe(5); });
});

describe('customRouteSchema', () => {
  const valid = { path: '/preview', port: 5173, label: 'Vite' };

  it('accepts a valid route', () => {
    expect(customRouteSchema.safeParse(valid).success).toBe(true);
  });
  it('accepts root path "/"', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/' }).success).toBe(true);
  });
  it('accepts multi-segment path /api/v1', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/api/v1' }).success).toBe(true);
  });
  it('rejects path without leading slash', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: 'preview' }).success).toBe(false);
  });
  it('rejects uppercase', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/Preview' }).success).toBe(false);
  });
  it('rejects traversal', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/foo/../bar' }).success).toBe(false);
  });
  it('rejects trailing slash', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/preview/' }).success).toBe(false);
  });
  it('rejects consecutive slashes', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/a//b' }).success).toBe(false);
  });
  it('rejects reserved paths', () => {
    for (const p of RESERVED_PATHS) {
      expect(customRouteSchema.safeParse({ ...valid, path: p }).success).toBe(false);
    }
  });
  it('rejects reserved subpaths at segment boundary', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/_static/x' }).success).toBe(false);
  });
  it('rejects reserved prefix markers like /stable-abc', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/stable-abc123' }).success).toBe(false);
  });
  it('rejects port 8080 with code-server message', () => {
    const res = customRouteSchema.safeParse({ ...valid, port: 8080 });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].message).toContain('code-server');
  });
  it('accepts former-reserved 3000 and 8000', () => {
    expect(customRouteSchema.safeParse({ ...valid, port: 3000 }).success).toBe(true);
    expect(customRouteSchema.safeParse({ ...valid, port: 8000 }).success).toBe(true);
  });
  it('rejects port below 1024 / above 65535', () => {
    expect(customRouteSchema.safeParse({ ...valid, port: 80 }).success).toBe(false);
    expect(customRouteSchema.safeParse({ ...valid, port: 70000 }).success).toBe(false);
  });
  it('rejects empty / too-long label', () => {
    expect(customRouteSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
    expect(customRouteSchema.safeParse({ ...valid, label: 'a'.repeat(33) }).success).toBe(false);
  });
});

describe('isReservedPath (segment boundary)', () => {
  it('treats /api as NOT reserved (seedable)', () => {
    expect(isReservedPath('/api')).toBe(false);
    expect(isReservedPath('/api/v1')).toBe(false);
  });
  it('does not misflag /apiary as reserved', () => {
    expect(isReservedPath('/apiary')).toBe(false);
  });
  it('flags /_static and /_static/x', () => {
    expect(isReservedPath('/_static')).toBe(true);
    expect(isReservedPath('/_static/main.js')).toBe(true);
  });
});

describe('customRoutesPayloadSchema', () => {
  const r = (path: string, port: number) => ({ path, port, label: 'x' });

  it('accepts empty list', () => {
    expect(customRoutesPayloadSchema.safeParse({ routes: [] }).success).toBe(true);
  });
  it('rejects duplicate paths', () => {
    expect(customRoutesPayloadSchema.safeParse({ routes: [r('/a', 5000), r('/a', 5001)] }).success).toBe(false);
  });
  it('rejects duplicate ports', () => {
    expect(customRoutesPayloadSchema.safeParse({ routes: [r('/a', 5000), r('/b', 5000)] }).success).toBe(false);
  });
  it('rejects more than one root path', () => {
    expect(customRoutesPayloadSchema.safeParse({ routes: [r('/', 5000), r('/', 5001)] }).success).toBe(false);
  });
  it('accepts a single root path', () => {
    expect(customRoutesPayloadSchema.safeParse({ routes: [r('/', 3000), r('/api', 8000)] }).success).toBe(true);
  });
  it('rejects more than MAX entries', () => {
    const routes = Array.from({ length: MAX_CUSTOM_ROUTES + 1 }, (_, i) => r(`/p${i}`, 5000 + i));
    expect(customRoutesPayloadSchema.safeParse({ routes }).success).toBe(false);
  });
  it('accepts exactly MAX entries', () => {
    const routes = Array.from({ length: MAX_CUSTOM_ROUTES }, (_, i) => r(`/p${i}`, 5000 + i));
    expect(customRoutesPayloadSchema.safeParse({ routes }).success).toBe(true);
  });
});
