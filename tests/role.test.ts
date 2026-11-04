import './setup-env.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { isRoleBasedLocalPart } from '../src/validators/role.js';

describe('role-based detection', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
  });

  it('detects common role locals', () => {
    expect(isRoleBasedLocalPart('admin')).toBe(true);
    expect(isRoleBasedLocalPart('info')).toBe(true);
    expect(isRoleBasedLocalPart('support+ticket')).toBe(true);
  });

  it('allows personal locals', () => {
    expect(isRoleBasedLocalPart('jane.doe')).toBe(false);
  });
});
