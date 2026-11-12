import './setup-env.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resetConfigCache, loadConfig, getConfig } from '../src/config/env.js';
import {
  ensureDisposableDatasetFile,
  loadDisposableDomains,
  resetDisposableCache,
  replaceDisposableDomainsFromText,
} from '../src/validators/disposable.js';
import {
  ensureFreeProvidersDatasetFile,
  loadFreeProviders,
  resetFreeProvidersCache,
} from '../src/validators/free-provider.js';
import {
  normalizeDisposableDomainEntry,
  parseDisposableSourceContent,
  syncDisposableDomainsFromSources,
  type DisposableSourceDef,
  type FetchLike,
} from '../src/validators/disposable-sync.js';
import { isDisposableDomain } from '../src/validators/disposable.js';
import { classifyProvider } from '../src/validators/provider.js';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

describe('normalizeDisposableDomainEntry', () => {
  it('normalizes case, trailing dots, and emails', () => {
    expect(normalizeDisposableDomainEntry('Mailinator.COM.')).toBe('mailinator.com');
    expect(normalizeDisposableDomainEntry('user@Temp-Mail.org')).toBe('temp-mail.org');
    expect(normalizeDisposableDomainEntry('@YopMail.com')).toBe('yopmail.com');
  });

  it('strips wildcard prefixes correctly', () => {
    expect(normalizeDisposableDomainEntry('*.33mail.com')).toBe('33mail.com');
    expect(normalizeDisposableDomainEntry('33mail.com', { wildcard: true })).toBe('33mail.com');
    expect(normalizeDisposableDomainEntry('.anonaddy.com', { wildcard: true })).toBe(
      'anonaddy.com',
    );
  });

  it('rejects invalid entries', () => {
    expect(normalizeDisposableDomainEntry('')).toBeNull();
    expect(normalizeDisposableDomainEntry('# comment')).toBeNull();
    expect(normalizeDisposableDomainEntry('nodot')).toBeNull();
    expect(normalizeDisposableDomainEntry('bad_domain!.com')).toBeNull();
  });
});

describe('parseDisposableSourceContent', () => {
  it('parses txt with comments and blanks', () => {
    const set = parseDisposableSourceContent(
      '# c\nmailinator.com\n\nGUERRILLAMAIL.COM.\n',
      'txt',
    );
    expect([...set].sort()).toEqual(['guerrillamail.com', 'mailinator.com']);
  });

  it('parses json arrays and wildcards', () => {
    const set = parseDisposableSourceContent(
      JSON.stringify(['Exact.TEST', '*.Wild.TEST', 'skip']),
      'json-array',
      { wildcard: true },
    );
    expect(set.has('exact.test')).toBe(true);
    expect(set.has('wild.test')).toBe(true);
    expect(set.has('skip')).toBe(false);
  });

  it('rejects non-array JSON', () => {
    expect(() => parseDisposableSourceContent('{"a":1}', 'json-array')).toThrow(/array/i);
  });
});

describe('syncDisposableDomainsFromSources', () => {
  const fixtureSources: DisposableSourceDef[] = [
    {
      id: 'A-blocklist',
      group: 'A',
      kind: 'blocklist',
      format: 'txt',
      url: 'https://raw.githubusercontent.com/example/a/main/block.txt',
    },
    {
      id: 'A-allowlist',
      group: 'A',
      kind: 'allowlist',
      format: 'txt',
      optional: true,
      url: 'https://raw.githubusercontent.com/example/a/main/allow.txt',
      fallbackUrls: [
        'https://raw.githubusercontent.com/example/a/main/allow-fallback.txt',
      ],
    },
    {
      id: 'B-domains-json',
      group: 'B',
      kind: 'blocklist',
      format: 'json-array',
      url: 'https://raw.githubusercontent.com/example/b/master/domains.json',
    },
    {
      id: 'D-wildcard',
      group: 'D',
      kind: 'blocklist',
      wildcard: true,
      format: 'json-array',
      url: 'https://raw.githubusercontent.com/example/d/master/wildcard.json',
    },
  ];

  const bodies: Record<string, string | Response> = {
    'https://raw.githubusercontent.com/example/a/main/block.txt': [
      'disp-a.test',
      'allow-me.test',
      'gmail.com',
      'mailinator.com',
      ...Array.from({ length: 40 }, (_, i) => `a-${i}.test`),
    ].join('\n'),
    'https://raw.githubusercontent.com/example/a/main/allow.txt': 'missing-will-404',
    'https://raw.githubusercontent.com/example/a/main/allow-fallback.txt':
      'allow-me.test\n',
    'https://raw.githubusercontent.com/example/b/master/domains.json': JSON.stringify([
      'disp-b.test',
      'outlook.com',
      ...Array.from({ length: 40 }, (_, i) => `b-${i}.test`),
    ]),
    'https://raw.githubusercontent.com/example/d/master/wildcard.json': JSON.stringify([
      '*.wild-disp.test',
      'apex-wild.test',
    ]),
  };

  const mockFetch: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith('/allow.txt')) {
      return textResponse('not found', 404);
    }
    const body = bodies[url];
    if (body === undefined) {
      return textResponse('missing', 404);
    }
    if (typeof body !== 'string') return body;
    if (url.endsWith('.json')) return jsonResponse(body);
    return textResponse(body);
  };

  beforeEach(() => {
    resetConfigCache();
    loadConfig();
    resetFreeProvidersCache();
    resetDisposableCache();
    ensureFreeProvidersDatasetFile();
    ensureDisposableDatasetFile();
    // Seed a stable previous disposable set large enough for ratio checks when needed.
    const seed = Array.from({ length: 80 }, (_, i) => `prev-${i}.test`);
    replaceDisposableDomainsFromText(seed.join('\n'), 'test-seed', { minCount: 50 });
    loadFreeProviders(true);
    loadDisposableDomains(true);
  });

  afterEach(() => {
    resetFreeProvidersCache();
    resetDisposableCache();
  });

  it('merges sources, applies allowlist + free exclusion, publishes atomically', async () => {
    const freePath = getConfig().freeProvidersPath;
    const beforeFree = sha256(freePath);

    const result = await syncDisposableDomainsFromSources({
      fetchImpl: mockFetch,
      sources: fixtureSources,
      minCount: 50,
      minRatio: 0.1,
    });

    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.freeProvidersUnchanged).toBe(true);
    expect(sha256(freePath)).toBe(beforeFree);
    expect(result.excludedAllowlist).toBeGreaterThanOrEqual(1);
    expect(result.excludedFree).toBeGreaterThanOrEqual(1);

    resetDisposableCache();
    const set = loadDisposableDomains(true);
    expect(set.has('disp-a.test')).toBe(true);
    expect(set.has('disp-b.test')).toBe(true);
    expect(set.has('allow-me.test')).toBe(false);
    expect(set.has('gmail.com')).toBe(false);
    expect(set.has('outlook.com')).toBe(false);
    expect(set.has('wild-disp.test')).toBe(true);
    expect(set.has('apex-wild.test')).toBe(true);

    expect(isDisposableDomain('sub.wild-disp.test')).toBe(true);
    expect(classifyProvider('gmail.com').provider_type).toBe('free');
    expect(classifyProvider('gmail.com').is_disposable).toBe(false);
  });

  it('uses allowlist fallback URL when primary 404s', async () => {
    const result = await syncDisposableDomainsFromSources({
      fetchImpl: mockFetch,
      sources: fixtureSources,
      minCount: 50,
      minRatio: 0.1,
      dryRun: true,
    });
    const allow = result.sources.find((s) => s.id === 'A-allowlist');
    expect(allow?.ok).toBe(true);
    expect(allow?.url).toContain('allow-fallback.txt');
  });

  it('fail-safe: keeps previous file when merged count below min', async () => {
    const file = getConfig().disposablePath;
    const before = readFileSync(file, 'utf8');

    const tiny: DisposableSourceDef[] = [
      {
        id: 'tiny',
        group: 'A',
        kind: 'blocklist',
        format: 'txt',
        url: 'https://raw.githubusercontent.com/example/a/main/block.txt',
      },
    ];
    const fetchTiny: FetchLike = async () => textResponse('only-one.test\n', 200);

    const result = await syncDisposableDomainsFromSources({
      fetchImpl: fetchTiny,
      sources: tiny,
      minCount: 500,
      minRatio: 0.1,
    });

    expect(result.ok).toBe(false);
    expect(result.published).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fail-safe: rejects shrink below min ratio', async () => {
    const file = getConfig().disposablePath;
    // Previous seeded to 80 domains.
    const before = readFileSync(file, 'utf8');

    const sources: DisposableSourceDef[] = [
      {
        id: 'small',
        group: 'C',
        kind: 'blocklist',
        format: 'txt',
        url: 'https://raw.githubusercontent.com/example/c/master/list.txt',
      },
    ];
    const fifty = Array.from({ length: 55 }, (_, i) => `new-${i}.test`).join('\n');
    const fetchImpl: FetchLike = async () => textResponse(fifty, 200);

    const result = await syncDisposableDomainsFromSources({
      fetchImpl,
      sources,
      minCount: 50,
      minRatio: 0.9, // 55 < 80*0.9
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/below/i);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fail-safe: all blocklist sources failing keeps previous file', async () => {
    const file = getConfig().disposablePath;
    const before = readFileSync(file, 'utf8');
    const sources: DisposableSourceDef[] = [
      {
        id: 'down',
        group: 'A',
        kind: 'blocklist',
        format: 'txt',
        url: 'https://raw.githubusercontent.com/example/a/main/missing.txt',
      },
    ];
    const fetchImpl: FetchLike = async () => textResponse('nope', 503);

    const result = await syncDisposableDomainsFromSources({
      fetchImpl,
      sources,
      minCount: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/all blocklist/i);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('dry-run does not rewrite disposable or free files', async () => {
    const disposablePath = getConfig().disposablePath;
    const freePath = getConfig().freeProvidersPath;
    const beforeDisp = readFileSync(disposablePath, 'utf8');
    const beforeFree = sha256(freePath);

    const result = await syncDisposableDomainsFromSources({
      fetchImpl: mockFetch,
      sources: fixtureSources,
      minCount: 50,
      minRatio: 0.1,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.published).toBe(false);
    expect(readFileSync(disposablePath, 'utf8')).toBe(beforeDisp);
    expect(sha256(freePath)).toBe(beforeFree);
  });

  it('never overwrites free-email-providers.txt even when free domains appear in sources', async () => {
    const freePath = getConfig().freeProvidersPath;
    expect(existsSync(freePath)).toBe(true);
    const before = readFileSync(freePath, 'utf8');
    const beforeHash = sha256(freePath);

    await syncDisposableDomainsFromSources({
      fetchImpl: mockFetch,
      sources: fixtureSources,
      minCount: 50,
      minRatio: 0.1,
    });

    expect(readFileSync(freePath, 'utf8')).toBe(before);
    expect(sha256(freePath)).toBe(beforeHash);
    // Touch-proof: content still loads as free, not disposable
    expect(loadFreeProviders(true).has('gmail.com')).toBe(true);
    expect(isDisposableDomain('gmail.com')).toBe(false);
  });

  it('rejects non-https or non-allowlisted hosts', async () => {
    const sources: DisposableSourceDef[] = [
      {
        id: 'bad-host',
        group: 'A',
        kind: 'blocklist',
        format: 'txt',
        url: 'https://evil.example/list.txt',
      },
    ];
    const result = await syncDisposableDomainsFromSources({
      fetchImpl: async () => textResponse('x.com\n', 200),
      sources,
      minCount: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.sources[0]?.error).toMatch(/allowlisted|Host/i);
  });
});

describe('free providers file isolation', () => {
  it('sync path does not call free-provider writers', () => {
    // Guardrail: free-provider module exposes update API for tests only;
    // disposable sync must not import it as a write dependency.
    const syncSrc = readFileSync(
      new URL('../src/validators/disposable-sync.ts', import.meta.url),
      'utf8',
    );
    expect(syncSrc).toMatch(/loadFreeProviders/);
    expect(syncSrc).not.toMatch(/updateFreeProvidersFromText/);
    expect(syncSrc).not.toMatch(/writeFileSync\([^)]*free/i);
  });
});
