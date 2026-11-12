/**
 * Multi-source disposable domain sync (opt-in CLI / GitHub Action only).
 * Never fetched per validation request. Never writes free-email-providers.txt.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getConfig } from '../config/env.js';
import { readResponseTextLimited } from '../utils/bounded-response.js';
import { mapPool } from '../utils/concurrency.js';
import { getLogger } from '../utils/logger.js';
import {
  getDisposableMeta,
  loadDisposableDomains,
  replaceDisposableDomainsFromText,
  type DisposableDatasetMeta,
} from './disposable.js';
import { loadFreeProviders } from './free-provider.js';
import { normalizeDomain, parseDomainListText } from './domain-set.js';

const log = getLogger('disposable-sync');

/** Hosts permitted for disposable list downloads. */
export const DISPOSABLE_SYNC_ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
  'disposable.github.io',
]);

/** Absolute floor for multi-source publish (fail-safe against truncated unions). */
export const DISPOSABLE_SYNC_MIN_COUNT = 5_000;

/** Reject publish when new count is below previous × ratio (unless previous is below min). */
export const DISPOSABLE_SYNC_MIN_RATIO = 0.5;

/** Max concurrent source downloads (bounded; keeps merge order deterministic via mapPool). */
export const DISPOSABLE_SYNC_CONCURRENCY = 4;

/**
 * Hard cap per source response body (stream-enforced).
 * Upstream lists today are ~1–3 MiB; 16 MiB leaves headroom without unbounded buffering.
 */
export const DISPOSABLE_SYNC_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Last tip commit that still contained allowlist.conf (removed 2026-04-12). */
export const DED_ALLOWLIST_FALLBACK_COMMIT = 'de9d20d740fb58c972e54f0a9fe1f2112a31ac00';

export type DisposableSourceFormat = 'txt' | 'json-array';
export type DisposableSourceKind = 'blocklist' | 'allowlist';

export type DisposableSourceDef = {
  id: string;
  group: 'A' | 'B' | 'C' | 'D';
  kind: DisposableSourceKind;
  /** When true, entries are treated as wildcard apex domains (*.example.com semantics). */
  wildcard?: boolean;
  format: DisposableSourceFormat;
  url: string;
  /** Tried in order after primary url fails (HTTP error / empty). */
  fallbackUrls?: string[];
  /** Soft-fail: missing/empty source does not abort the whole sync. */
  optional?: boolean;
};

/**
 * Verified multi-source definitions (A–D).
 * Source A allowlist: tip removed upstream; primary URL may 404, fallback pinned SHA.
 */
export const DISPOSABLE_SYNC_SOURCES: readonly DisposableSourceDef[] = [
  {
    id: 'A-blocklist',
    group: 'A',
    kind: 'blocklist',
    format: 'txt',
    url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
    fallbackUrls: [
      'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf',
    ],
  },
  {
    id: 'A-allowlist',
    group: 'A',
    kind: 'allowlist',
    format: 'txt',
    optional: true,
    url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/allowlist.conf',
    fallbackUrls: [
      'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/allowlist.conf',
      `https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/${DED_ALLOWLIST_FALLBACK_COMMIT}/allowlist.conf`,
    ],
  },
  {
    id: 'B-domains-txt',
    group: 'B',
    kind: 'blocklist',
    format: 'txt',
    url: 'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt',
  },
  {
    id: 'B-domains-strict-txt',
    group: 'B',
    kind: 'blocklist',
    format: 'txt',
    // Strict includes freemail/alias hosts — free + allowlist exclusion strips them.
    url: 'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains_strict.txt',
  },
  {
    id: 'B-domains-json',
    group: 'B',
    kind: 'blocklist',
    format: 'json-array',
    url: 'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.json',
  },
  {
    id: 'C-mailchecker',
    group: 'C',
    kind: 'blocklist',
    format: 'txt',
    url: 'https://raw.githubusercontent.com/FGRibreau/mailchecker/master/list.txt',
  },
  {
    id: 'D-ivolo-exact',
    group: 'D',
    kind: 'blocklist',
    format: 'json-array',
    url: 'https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/index.json',
  },
  {
    id: 'D-ivolo-wildcard',
    group: 'D',
    kind: 'blocklist',
    wildcard: true,
    format: 'json-array',
    url: 'https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/wildcard.json',
  },
];

const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SourceFetchResult = {
  id: string;
  group: DisposableSourceDef['group'];
  kind: DisposableSourceKind;
  ok: boolean;
  url: string;
  count: number;
  error?: string;
  domains: Set<string>;
};

export type DisposableSyncOptions = {
  fetchImpl?: FetchLike;
  sources?: readonly DisposableSourceDef[];
  freeProviders?: Set<string>;
  /** Absolute minimum domains after exclusions (default DISPOSABLE_SYNC_MIN_COUNT). */
  minCount?: number;
  /** Minimum new/previous ratio (default DISPOSABLE_SYNC_MIN_RATIO). */
  minRatio?: number;
  /** When true, validate thresholds but do not write the disposable file. */
  dryRun?: boolean;
  timeoutMs?: number;
  /** Per-source body byte cap (default DISPOSABLE_SYNC_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Parallel source downloads (default DISPOSABLE_SYNC_CONCURRENCY). */
  concurrency?: number;
};

export type DisposableSyncResult = {
  ok: boolean;
  published: boolean;
  dryRun: boolean;
  count: number;
  previousCount: number;
  excludedAllowlist: number;
  excludedFree: number;
  sourceLabel: string;
  sources: Array<{
    id: string;
    group: string;
    kind: string;
    ok: boolean;
    url: string;
    count: number;
    error?: string;
  }>;
  meta?: DisposableDatasetMeta;
  error?: string;
  /** SHA-256 of free-providers file before sync (proves we did not rewrite it). */
  freeProvidersSha256Before: string | null;
  freeProvidersSha256After: string | null;
  freeProvidersUnchanged: boolean;
};

export function assertDisposableSyncUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid disposable sync URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Disposable dataset URL must use https: ${url}`);
  }
  if (!DISPOSABLE_SYNC_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Host not allowlisted for disposable updates: ${parsed.hostname}. Allowed: ${[
        ...DISPOSABLE_SYNC_ALLOWED_HOSTS,
      ].join(', ')}`,
    );
  }
  return parsed;
}

/**
 * Normalize a raw list entry into a registrable / apex domain, or null if invalid.
 * Handles emails (takes host), leading @, trailing dots, and `*.` wildcards.
 */
export function normalizeDisposableDomainEntry(
  raw: string,
  options: { wildcard?: boolean } = {},
): string | null {
  let t = raw.trim().toLowerCase();
  if (!t || t.startsWith('#')) return null;

  // JSON / CSV noise
  t = t.replace(/^["']+|["']+$/g, '');
  if (!t) return null;

  if (t.includes('@')) {
    t = t.slice(t.lastIndexOf('@') + 1);
  }
  t = t.replace(/^@+/, '');
  t = t.replace(/\.$/, '');

  // Wildcard forms: *.example.com or .example.com → example.com
  if (t.startsWith('*.')) {
    t = t.slice(2);
  } else if (options.wildcard && t.startsWith('.')) {
    t = t.slice(1);
  }

  t = normalizeDomain(t);
  if (!t || !t.includes('.')) return null;
  if (t.length > 253) return null;
  if (!DOMAIN_RE.test(t)) return null;
  return t;
}

export function parseDisposableSourceContent(
  content: string,
  format: DisposableSourceFormat,
  options: { wildcard?: boolean } = {},
): Set<string> {
  const out = new Set<string>();
  if (!content || !content.trim()) return out;

  if (format === 'json-array') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Invalid JSON disposable list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error('Disposable JSON list must be an array of strings');
    }
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const d = normalizeDisposableDomainEntry(item, options);
      if (d) out.add(d);
    }
    return out;
  }

  for (const line of content.split(/\r?\n/)) {
    // mailchecker / txt may use commas on a line — split conservatively
    const parts = line.includes(',') ? line.split(',') : [line];
    for (const part of parts) {
      const d = normalizeDisposableDomainEntry(part, options);
      if (d) out.add(d);
    }
  }
  return out;
}

/**
 * Download one allowlisted HTTPS URL.
 * Fail-closed: redirect:'error' (no bounce), HTTPS+host pre-check, stream size cap.
 */
export async function downloadDisposableText(
  url: string,
  fetchImpl: FetchLike,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  assertDisposableSyncUrl(url);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? DISPOSABLE_SYNC_MAX_RESPONSE_BYTES;

  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    // Never follow redirects (SSRF: allowlisted URL must not bounce off-allowlist).
    redirect: 'error',
  });
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await readResponseTextLimited(res, maxBytes);
  if (!text || !text.trim()) {
    throw new Error('empty body');
  }
  return text;
}

export async function fetchDisposableSource(
  source: DisposableSourceDef,
  fetchImpl: FetchLike,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SourceFetchResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? DISPOSABLE_SYNC_MAX_RESPONSE_BYTES;
  // Preserve declared fallback order: primary, then fallbackUrls in array order.
  const urls = [source.url, ...(source.fallbackUrls ?? [])];
  let lastError = 'no URL attempted';
  for (const url of urls) {
    try {
      const text = await downloadDisposableText(url, fetchImpl, {
        timeoutMs,
        maxBytes,
      });
      const domains = parseDisposableSourceContent(text, source.format, {
        wildcard: source.wildcard,
      });
      if (domains.size === 0) {
        lastError = 'parsed zero domains';
        continue;
      }
      return {
        id: source.id,
        group: source.group,
        kind: source.kind,
        ok: true,
        url,
        count: domains.size,
        domains,
      };
    } catch (err) {
      // Per-URL / per-source isolation: errors stay local; caller merges survivors.
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    id: source.id,
    group: source.group,
    kind: source.kind,
    ok: false,
    url: source.url,
    count: 0,
    error: lastError,
    domains: new Set(),
  };
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function previousDisposableCount(): number {
  try {
    return loadDisposableDomains(true).size;
  } catch {
    return 0;
  }
}

/**
 * Fetch sources A–D, merge blocklists, subtract allowlist + free providers,
 * enforce fail-safe thresholds, atomically replace disposable-domains.txt.
 * Does not modify free-email-providers.txt.
 */
export async function syncDisposableDomainsFromSources(
  options: DisposableSyncOptions = {},
): Promise<DisposableSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sources = options.sources ?? DISPOSABLE_SYNC_SOURCES;
  const minCount = options.minCount ?? DISPOSABLE_SYNC_MIN_COUNT;
  const minRatio = options.minRatio ?? DISPOSABLE_SYNC_MIN_RATIO;
  const dryRun = options.dryRun ?? false;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxResponseBytes ?? DISPOSABLE_SYNC_MAX_RESPONSE_BYTES;
  const concurrency = options.concurrency ?? DISPOSABLE_SYNC_CONCURRENCY;

  const cfg = getConfig();
  const freePath = cfg.freeProvidersPath;
  const freeShaBefore = sha256File(freePath);

  const free =
    options.freeProviders ??
    (() => {
      try {
        return loadFreeProviders(true);
      } catch {
        return new Set<string>();
      }
    })();

  const prevCount = previousDisposableCount();

  // Bounded concurrency; mapPool keeps results aligned to source declaration order.
  const fetched = await mapPool(sources, concurrency, async (source) => {
    const result = await fetchDisposableSource(source, fetchImpl, {
      timeoutMs,
      maxBytes,
    });
    if (!result.ok) {
      log.warn({ id: source.id, error: result.error }, 'Disposable source failed');
    } else {
      log.info(
        { id: source.id, count: result.count, url: result.url },
        'Disposable source fetched',
      );
    }
    return result;
  });

  // Deterministic merge: walk sources in declaration order (not completion order).
  const blockOk = fetched.filter((s) => s.kind === 'blocklist' && s.ok);
  const allowOk = fetched.filter((s) => s.kind === 'allowlist' && s.ok);

  const sourceSummaries = fetched.map((s) => ({
    id: s.id,
    group: s.group,
    kind: s.kind,
    ok: s.ok,
    url: s.url,
    count: s.count,
    ...(s.error ? { error: s.error } : {}),
  }));

  const baseResult = {
    dryRun,
    previousCount: prevCount,
    sources: sourceSummaries,
    freeProvidersSha256Before: freeShaBefore,
  };

  if (blockOk.length === 0) {
    const freeShaAfter = sha256File(freePath);
    return {
      ...baseResult,
      ok: false,
      published: false,
      count: prevCount,
      excludedAllowlist: 0,
      excludedFree: 0,
      sourceLabel: 'multi-source-sync',
      error: 'All blocklist sources failed; previous disposable dataset left unchanged.',
      freeProvidersSha256After: freeShaAfter,
      freeProvidersUnchanged: freeShaBefore === freeShaAfter,
    };
  }

  const merged = new Set<string>();
  for (const s of blockOk) {
    for (const d of s.domains) merged.add(d);
  }

  const allowlist = new Set<string>();
  for (const s of allowOk) {
    for (const d of s.domains) allowlist.add(d);
  }

  let excludedAllowlist = 0;
  let excludedFree = 0;
  const filtered: string[] = [];
  for (const d of merged) {
    if (allowlist.has(d)) {
      excludedAllowlist += 1;
      continue;
    }
    if (free.has(d)) {
      excludedFree += 1;
      continue;
    }
    filtered.push(d);
  }
  filtered.sort();

  const sourceLabel = `multi-source:${blockOk.map((s) => s.id).join('+')}${
    allowOk.length ? `;allowlist:${allowOk.map((s) => s.id).join('+')}` : ''
  }`;

  if (filtered.length < minCount) {
    const freeShaAfter = sha256File(freePath);
    return {
      ...baseResult,
      ok: false,
      published: false,
      count: filtered.length,
      excludedAllowlist,
      excludedFree,
      sourceLabel,
      error: `Disposable sync rejected: got ${filtered.length} domains after exclusions, need at least ${minCount}. Previous dataset left unchanged.`,
      freeProvidersSha256After: freeShaAfter,
      freeProvidersUnchanged: freeShaBefore === freeShaAfter,
    };
  }

  if (prevCount > minCount && filtered.length < Math.floor(prevCount * minRatio)) {
    const freeShaAfter = sha256File(freePath);
    return {
      ...baseResult,
      ok: false,
      published: false,
      count: filtered.length,
      excludedAllowlist,
      excludedFree,
      sourceLabel,
      error: `Disposable sync rejected: ${filtered.length} domains is below ${minRatio}× previous (${prevCount}). Previous dataset left unchanged.`,
      freeProvidersSha256After: freeShaAfter,
      freeProvidersUnchanged: freeShaBefore === freeShaAfter,
    };
  }

  if (dryRun) {
    const freeShaAfter = sha256File(freePath);
    return {
      ...baseResult,
      ok: true,
      published: false,
      count: filtered.length,
      excludedAllowlist,
      excludedFree,
      sourceLabel,
      freeProvidersSha256After: freeShaAfter,
      freeProvidersUnchanged: freeShaBefore === freeShaAfter,
    };
  }

  // Atomic replace (temp → rename) via existing fail-safe writer; strips free again.
  const body = filtered.join('\n') + '\n';
  const meta = replaceDisposableDomainsFromText(body, sourceLabel, {
    minCount,
  });

  const freeShaAfter = sha256File(freePath);
  const freeUnchanged = freeShaBefore === freeShaAfter;
  if (!freeUnchanged) {
    throw new Error(
      'Refusing success: free-email-providers.txt changed during disposable sync (must never be overwritten).',
    );
  }

  return {
    ...baseResult,
    ok: true,
    published: true,
    count: meta.count,
    excludedAllowlist,
    excludedFree,
    sourceLabel,
    meta: meta ?? getDisposableMeta(),
    freeProvidersSha256After: freeShaAfter,
    freeProvidersUnchanged: freeUnchanged,
  };
}

/** Re-export parse helper for tests that compare against legacy newline parser. */
export function parsePlainDomainList(content: string): Set<string> {
  return parseDomainListText(content);
}
