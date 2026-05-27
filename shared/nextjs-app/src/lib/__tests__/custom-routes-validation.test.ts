import { describe, it, expect } from 'vitest';
import {
  customRouteSchema,
  customRoutesPayloadSchema,
  RESERVED_PATHS,
  RESERVED_PORTS,
  MAX_CUSTOM_ROUTES,
} from '../validation';

describe('customRouteSchema', () => {
  const valid = { path: '/preview', port: 5173, label: 'Vite' };

  it('accepts a valid route', () => {
    expect(customRouteSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects path without leading slash', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: 'preview' }).success).toBe(false);
  });

  it('rejects path with uppercase', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/Preview' }).success).toBe(false);
  });

  it('rejects path with traversal characters', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/foo/../bar' }).success).toBe(false);
  });

  it('rejects path longer than 32 chars', () => {
    expect(customRouteSchema.safeParse({ ...valid, path: '/' + 'a'.repeat(32) }).success).toBe(false);
  });

  it('rejects reserved paths', () => {
    for (const p of RESERVED_PATHS) {
      expect(customRouteSchema.safeParse({ ...valid, path: p }).success).toBe(false);
    }
  });

  it('rejects paths that start with a reserved prefix marker', () => {
    // /stable- is a reserved prefix; any path starting with it must be rejected
    expect(customRouteSchema.safeParse({ ...valid, path: '/stable-abc123' }).success).toBe(false);
  });

  it('rejects port below 1024', () => {
    expect(customRouteSchema.safeParse({ ...valid, port: 80 }).success).toBe(false);
  });

  it('rejects port above 65535', () => {
    expect(customRouteSchema.safeParse({ ...valid, port: 70000 }).success).toBe(false);
  });

  it('rejects reserved ports', () => {
    for (const p of RESERVED_PORTS) {
      expect(customRouteSchema.safeParse({ ...valid, port: p }).success).toBe(false);
    }
  });

  it('rejects empty label', () => {
    expect(customRouteSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
  });

  it('rejects label longer than 32 chars', () => {
    expect(customRouteSchema.safeParse({ ...valid, label: 'a'.repeat(33) }).success).toBe(false);
  });
});

describe('customRoutesPayloadSchema', () => {
  const r = (path: string, port: number) => ({ path, port, label: 'x' });

  it('accepts empty list', () => {
    expect(customRoutesPayloadSchema.safeParse({ routes: [] }).success).toBe(true);
  });

  it('rejects duplicate paths', () => {
    const result = customRoutesPayloadSchema.safeParse({
      routes: [r('/a', 5000), r('/a', 5001)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate ports', () => {
    const result = customRoutesPayloadSchema.safeParse({
      routes: [r('/a', 5000), r('/b', 5000)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than MAX_CUSTOM_ROUTES entries', () => {
    const routes = Array.from({ length: MAX_CUSTOM_ROUTES + 1 }, (_, i) =>
      r(`/p${i}`, 5000 + i),
    );
    expect(customRoutesPayloadSchema.safeParse({ routes }).success).toBe(false);
  });

  it('accepts exactly MAX_CUSTOM_ROUTES entries', () => {
    const routes = Array.from({ length: MAX_CUSTOM_ROUTES }, (_, i) =>
      r(`/p${i}`, 5000 + i),
    );
    expect(customRoutesPayloadSchema.safeParse({ routes }).success).toBe(true);
  });
});
