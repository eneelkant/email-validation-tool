import './setup-env.js';
import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetConfigCache, loadConfig, getConfig } from '../src/config/env.js';
import { assertSafeUserPath } from '../src/security/paths.js';
import { sanitizeCsvCell } from '../src/security/csv.js';

describe('security', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
  });

  it('blocks path traversal', () => {
    const cfg = getConfig();
    expect(() =>
      assertSafeUserPath('../../etc/passwd', {
        mustExist: false,
        allowedRoots: [cfg.uploadDir],
      }),
    ).toThrow(/escapes|does not exist|Path/);
  });

  it('allows paths under upload dir', () => {
    const cfg = getConfig();
    const p = path.join(cfg.uploadDir, 'list.csv');
    const resolved = assertSafeUserPath(p, {
      mustExist: false,
      allowedRoots: [cfg.uploadDir],
    });
    expect(resolved.startsWith(cfg.uploadDir)).toBe(true);
  });

  it('sanitizes CSV formula injection', () => {
    expect(sanitizeCsvCell('=1+1')).toBe("'=1+1");
    expect(sanitizeCsvCell('+cmd')).toBe("'+cmd");
    expect(sanitizeCsvCell('hello')).toBe('hello');
  });
});
