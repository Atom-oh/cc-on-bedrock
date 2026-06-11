import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('@aws-sdk/client-dynamodb', async (orig) => {
  const actual = await orig<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: class { send = sendMock; },
  };
});

import { getCustomRoutes, putCustomRoutes, batchGetCustomRoutes, DEFAULT_SEED_ROUTES } from '../ec2-clients';
import { marshall } from '@aws-sdk/util-dynamodb';

beforeEach(() => sendMock.mockReset());

describe('getCustomRoutes', () => {
  it('returns [] and version 0 when record has no customRoutes (but exists)', async () => {
    sendMock.mockResolvedValueOnce({ Item: marshall({ user_id: 'alice' }) });
    const res = await getCustomRoutes('alice');
    expect(res.customRoutes).toEqual([]);
    expect(res.routesVersion).toBe(0);
    expect(res.exists).toBe(true);
  });

  it('exists=false when no instance record', async () => {
    sendMock.mockResolvedValueOnce({}); // no Item
    const res = await getCustomRoutes('ghost');
    expect(res.exists).toBe(false);
  });

  it('returns stored routes + version', async () => {
    sendMock.mockResolvedValueOnce({
      Item: marshall({ user_id: 'alice', customRoutes: [{ path: '/p', port: 5000, label: 'x' }], routesVersion: 3 }),
    });
    const res = await getCustomRoutes('alice');
    expect(res.customRoutes).toHaveLength(1);
    expect(res.routesVersion).toBe(3);
  });
});

describe('DEFAULT_SEED_ROUTES', () => {
  it('seeds root->3000 and /api->8000', () => {
    expect(DEFAULT_SEED_ROUTES).toEqual([
      { path: '/', port: 3000, label: 'Frontend' },
      { path: '/api', port: 8000, label: 'API' },
    ]);
  });
});

describe('putCustomRoutes', () => {
  it('writes with incremented version via conditional update', async () => {
    sendMock.mockResolvedValueOnce({}); // UpdateItem ok
    const newVersion = await putCustomRoutes('alice', [{ path: '/p', port: 5000, label: 'x' }], 2);
    expect(newVersion).toBe(3);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.ConditionExpression).toContain('routesVersion');
    expect(cmd.input.TableName).toBe('cc-user-instances');
  });

  it('guards against phantom-row upsert: condition requires the instance row to exist', async () => {
    // If the instance row is deleted between the PUT handler's existence check
    // and this UpdateItem, `attribute_not_exists(routesVersion)` would be true on
    // the now-missing row and UpdateItem would UPSERT a phantom instance row.
    // Requiring attribute_exists(user_id) makes the write a no-op on a missing row.
    sendMock.mockResolvedValueOnce({});
    await putCustomRoutes('alice', [{ path: '/p', port: 5000, label: 'x' }], 2);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.ConditionExpression).toContain('attribute_exists(user_id)');
  });

  it('throws version-conflict on ConditionalCheckFailedException', async () => {
    const err = new Error('cond'); err.name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValueOnce(err);
    await expect(putCustomRoutes('alice', [], 1)).rejects.toThrow('version-conflict');
  });
});

describe('batchGetCustomRoutes (M2: N+1 → BatchGetItem)', () => {
  it('returns a map of subdomain → customRoutes in one batch', async () => {
    sendMock.mockResolvedValueOnce({
      Responses: {
        'cc-user-instances': [
          marshall({ user_id: 'alice', customRoutes: [{ path: '/a', port: 5000, label: 'A' }] }),
          marshall({ user_id: 'bob', customRoutes: [] }),
        ],
      },
      UnprocessedKeys: {},
    });
    const m = await batchGetCustomRoutes(['alice', 'bob', 'alice']); // dup deduped
    expect(m.get('alice')).toHaveLength(1);
    expect(m.get('bob')).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty map for empty input without calling DDB', async () => {
    const m = await batchGetCustomRoutes([]);
    expect(m.size).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
