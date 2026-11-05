import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetConfigCache, resolveHttpPort, loadConfig } from '../src/config/env.js';
import './setup-env.js';

describe('resolveHttpPort', () => {
  it('prefers platform PORT when set to a positive integer', () => {
    expect(resolveHttpPort({ PORT: '10000' }, 8787)).toBe(10000);
  });

  it('falls back to OPENVERIFY_HTTP_PORT when PORT is unset or invalid', () => {
    expect(resolveHttpPort({}, 8787)).toBe(8787);
    expect(resolveHttpPort({ PORT: '' }, 8787)).toBe(8787);
    expect(resolveHttpPort({ PORT: 'nope' }, 8787)).toBe(8787);
    expect(resolveHttpPort({ PORT: '0' }, 8787)).toBe(8787);
  });
});

describe('loadConfig PORT override', () => {
  const prevPort = process.env.PORT;

  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    resetConfigCache();
  });

  it('uses PORT over OPENVERIFY_HTTP_PORT', () => {
    process.env.PORT = '10000';
    process.env.OPENVERIFY_HTTP_PORT = '8787';
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(10000);
  });
});
