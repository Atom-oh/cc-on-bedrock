import { describe, it, expect } from 'vitest';
import { createUserSchema, updateUserSchema, startContainerSchema, stopContainerSchema, keepAliveSchema } from '../validation';

describe('createUserSchema', () => {
  const validInput = {
    email: 'user@example.com',
    subdomain: 'user01',
    department: 'engineering',
    containerOs: 'ubuntu' as const,
    resourceTier: 'standard' as const,
    securityPolicy: 'restricted' as const,
  };

  it('accepts valid input', () => {
    const result = createUserSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('defaults department to "default"', () => {
    const { department, ...rest } = validInput;
    const result = createUserSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.department).toBe('default');
  });

  it('rejects invalid email', () => {
    const result = createUserSchema.safeParse({ ...validInput, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects subdomain with path traversal', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: '../../root' });
    expect(result.success).toBe(false);
  });

  it('rejects subdomain with uppercase', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: 'User01' });
    expect(result.success).toBe(false);
  });

  it('rejects subdomain starting with hyphen', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: '-user01' });
    expect(result.success).toBe(false);
  });

  it('rejects subdomain ending with hyphen', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: 'user01-' });
    expect(result.success).toBe(false);
  });

  it('rejects subdomain shorter than 3 chars', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: 'ab' });
    expect(result.success).toBe(false);
  });

  it('rejects subdomain with special chars', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: 'user@01' });
    expect(result.success).toBe(false);
  });

  it('accepts valid subdomain with hyphens', () => {
    const result = createUserSchema.safeParse({ ...validInput, subdomain: 'my-user-01' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid containerOs', () => {
    const result = createUserSchema.safeParse({ ...validInput, containerOs: 'windows' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid resourceTier', () => {
    const result = createUserSchema.safeParse({ ...validInput, resourceTier: 'mega' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid securityPolicy', () => {
    const result = createUserSchema.safeParse({ ...validInput, securityPolicy: 'none' });
    expect(result.success).toBe(false);
  });
});

describe('updateUserSchema', () => {
  it('accepts username only', () => {
    const result = updateUserSchema.safeParse({ username: 'user123' });
    expect(result.success).toBe(true);
  });

  it('accepts partial updates', () => {
    const result = updateUserSchema.safeParse({ username: 'user123', resourceTier: 'power' });
    expect(result.success).toBe(true);
  });

  it('rejects missing username', () => {
    const result = updateUserSchema.safeParse({ resourceTier: 'power' });
    expect(result.success).toBe(false);
  });
});

describe('startContainerSchema', () => {
  const validInput = {
    username: 'user@example.com',
    subdomain: 'user01',
    department: 'default',
    containerOs: 'ubuntu' as const,
    resourceTier: 'standard' as const,
    securityPolicy: 'restricted' as const,
  };

  it('accepts valid input', () => {
    const result = startContainerSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('rejects invalid subdomain', () => {
    const result = startContainerSchema.safeParse({ ...validInput, subdomain: '../hack' });
    expect(result.success).toBe(false);
  });
});

describe('stopContainerSchema', () => {
  it('accepts valid subdomain', () => {
    const result = stopContainerSchema.safeParse({
      subdomain: 'user01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid subdomain', () => {
    const result = stopContainerSchema.safeParse({ subdomain: '../hack' });
    expect(result.success).toBe(false);
  });
});

describe('keepAliveSchema', () => {
  it('accepts empty input', () => {
    const result = keepAliveSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid email userId', () => {
    const result = keepAliveSchema.safeParse({ userId: 'user@example.com' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid email userId', () => {
    const result = keepAliveSchema.safeParse({ userId: 'not-email' });
    expect(result.success).toBe(false);
  });
});
