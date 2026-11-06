import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  resetConfigCache,
  resolveHttpPort,
  resolveHttpHost,
  loadConfig,
} from '../src/config/env.js';
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

describe('resolveHttpHost', () => {
  it('binds 0.0.0.0 when PORT is set and OPENVERIFY_HTTP_HOST is unset', () => {
    expect(resolveHttpHost({ PORT: '8080' }, '127.0.0.1')).toBe('0.0.0.0');
  });

  it('keeps explicit OPENVERIFY_HTTP_HOST', () => {
    expect(
      resolveHttpHost({ PORT: '8080', OPENVERIFY_HTTP_HOST: '127.0.0.1' }, '127.0.0.1'),
    ).toBe('127.0.0.1');
    expect(
      resolveHttpHost({ OPENVERIFY_HTTP_HOST: '0.0.0.0' }, '0.0.0.0'),
    ).toBe('0.0.0.0');
  });

  it('keeps configured host when PORT is unset (local default)', () => {
    expect(resolveHttpHost({}, '127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('loadConfig PORT override', () => {
  const prevPort = process.env.PORT;
  const prevHost = process.env.OPENVERIFY_HTTP_HOST;

  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevHost === undefined) delete process.env.OPENVERIFY_HTTP_HOST;
    else process.env.OPENVERIFY_HTTP_HOST = prevHost;
    resetConfigCache();
  });

  it('uses PORT over OPENVERIFY_HTTP_PORT', () => {
    process.env.PORT = '10000';
    process.env.OPENVERIFY_HTTP_PORT = '8787';
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(10000);
  });

  it('defaults host to 0.0.0.0 when only PORT is injected', () => {
    process.env.PORT = '10000';
    delete process.env.OPENVERIFY_HTTP_HOST;
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(10000);
    expect(cfg.httpHost).toBe('0.0.0.0');
  });
});
