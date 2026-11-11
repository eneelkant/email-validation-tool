import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { getConfig, isReadonlyDeployPath } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { domainOrParentInSet, parseDomainListText } from './domain-set.js';
import { isFreeProviderDomain, loadFreeProviders } from './free-provider.js';

const log = getLogger('disposable');

export type DisposableDatasetMeta = {
  version: string;
  updated_at: string;
  count: number;
  source: string;
};

let domainSet: Set<string> | null = null;
let meta: DisposableDatasetMeta | null = null;

const DEFAULT_SEED = [
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  'tempmail.com',
  'temp-mail.org',
  '10minutemail.com',
  'yopmail.com',
  'trashmail.com',
  'discard.email',
  'mailnesia.com',
  'maildrop.cc',
  'getnada.com',
  'tempail.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'emailondeck.com',
  'mintemail.com',
  'moakt.com',
  'dispostable.com',
];

/** Minimum domain count for a full replace refresh (fail-safe against truncated downloads). */
export const DISPOSABLE_REPLACE_MIN_COUNT = 500;

export function ensureDisposableDatasetFile(): string {
  const cfg = getConfig();
  const file = cfg.disposablePath;
  if (existsSync(file)) {
    return file;
  }
  // Never mkdir under serverless package roots (e.g. /var/task). Ephemeral config
  // remaps missing disposable paths to os.tmpdir(); packaged seeds are read-only OK.
  if (isReadonlyDeployPath(file)) {
    throw new Error(
      `Disposable dataset missing under read-only deploy path: ${file}. ` +
        `Enable OPENVERIFY_EPHEMERAL_STORAGE or set OPENVERIFY_DISPOSABLE_PATH to a writable file.`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const header = [
    '# MailSure MCP disposable domain dataset',
    '# Source: curated local seed (not downloaded per request)',
    `# Updated: ${new Date().toISOString()}`,
    '# One domain per line. Lines starting with # are comments.',
    '# Free email providers are never classified as disposable.',
    '',
    ...DEFAULT_SEED,
    '',
  ].join('\n');
  writeFileSync(file, header, 'utf8');
  log.info({ file, count: DEFAULT_SEED.length }, 'Wrote seed disposable domain dataset');
  return file;
}

export function loadDisposableDomains(force = false): Set<string> {
  if (domainSet && !force) return domainSet;
  const file = ensureDisposableDatasetFile();
  const text = readFileSync(file, 'utf8');
  const domains = parseDomainListText(text);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const updatedMatch = text.match(/Updated:\s*(\S+)/i);
  meta = {
    version: hash,
    updated_at: updatedMatch?.[1] ?? new Date().toISOString(),
    count: domains.size,
    source: file,
  };
  domainSet = domains;
  log.info({ count: domains.size, version: hash }, 'Loaded disposable domains');
  return domains;
}

export function getDisposableMeta(): DisposableDatasetMeta {
  if (!meta) loadDisposableDomains();
  return meta!;
}

/** Raw list membership (parent-domain aware). Does not apply free-provider exclusion. */
export function isDisposableDomainListed(domain: string): boolean {
  return domainOrParentInSet(domain, loadDisposableDomains());
}

/**
 * Disposable hit for validation: true only when listed AND not a free provider.
 * Prefer classifyProvider() for full provider_type classification.
 */
export function isDisposableDomain(domain: string): boolean {
  if (isFreeProviderDomain(domain)) return false;
  return isDisposableDomainListed(domain);
}

function writeDisposableFile(
  domains: Iterable<string>,
  sourceLabel: string,
): DisposableDatasetMeta {
  const file = ensureDisposableDatasetFile();
  // Exclude free providers from the persisted disposable file when possible.
  let free: Set<string>;
  try {
    free = loadFreeProviders();
  } catch {
    free = new Set();
  }
  const filtered = [...domains].filter((d) => !free.has(d)).sort();
  const now = new Date().toISOString();
  const body = [
    '# MailSure MCP disposable domain dataset',
    `# Source: ${sourceLabel}`,
    `# Updated: ${now}`,
    '# One domain per line. Lines starting with # are comments.',
    '# Free email providers are stripped on write and never classified as disposable.',
    '',
    ...filtered,
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  domainSet = null;
  meta = null;
  return getDisposableMeta();
}

/**
 * Merge remote or local list content into the dataset file (deduped).
 * Does not download automatically on every validation — call explicitly via tool/script.
 */
export function updateDisposableDomainsFromText(
  content: string,
  sourceLabel = 'manual-update',
): DisposableDatasetMeta {
  const existing = loadDisposableDomains(true);
  for (const d of parseDomainListText(content)) {
    existing.add(d);
  }
  return writeDisposableFile(existing, sourceLabel);
}

/**
 * Fail-safe full replace of the disposable dataset.
 * Writes atomically (temp → rename). On validation failure the previous file is kept.
 */
export function replaceDisposableDomainsFromText(
  content: string,
  sourceLabel = 'replace-update',
  options: { minCount?: number } = {},
): DisposableDatasetMeta {
  const minCount = options.minCount ?? DISPOSABLE_REPLACE_MIN_COUNT;
  const parsed = parseDomainListText(content);
  if (parsed.size < minCount) {
    throw new Error(
      `Disposable replace rejected: got ${parsed.size} domains, need at least ${minCount}. ` +
        'Previous dataset left unchanged.',
    );
  }

  let free: Set<string>;
  try {
    free = loadFreeProviders();
  } catch {
    free = new Set();
  }
  const filtered = [...parsed].filter((d) => !free.has(d)).sort();
  if (filtered.length < minCount) {
    throw new Error(
      `Disposable replace rejected after free-provider exclusion: ${filtered.length} domains ` +
        `(min ${minCount}). Previous dataset left unchanged.`,
    );
  }

  const file = ensureDisposableDatasetFile();
  const now = new Date().toISOString();
  const body = [
    '# MailSure MCP disposable domain dataset',
    `# Source: ${sourceLabel}`,
    `# Updated: ${now}`,
    '# One domain per line. Lines starting with # are comments.',
    '# Free email providers are stripped on write and never classified as disposable.',
    '',
    ...filtered,
    '',
  ].join('\n');

  const dir = path.dirname(file);
  const tmp = path.join(dir, `.disposable-domains.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }

  domainSet = null;
  meta = null;
  return getDisposableMeta();
}

/**
 * Fetch a public disposable domain list (opt-in). Documented sources only.
 * Uses fail-safe replace (keeps previous file if download/parse/size checks fail).
 */
export async function updateDisposableDomainsFromUrl(
  url: string,
  options: { mode?: 'merge' | 'replace'; minCount?: number } = {},
): Promise<DisposableDatasetMeta> {
  const allowedHosts = new Set([
    'raw.githubusercontent.com',
    'cdn.jsdelivr.net',
  ]);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Disposable dataset URL must use https');
  }
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(
      `Host not allowlisted for disposable updates: ${parsed.hostname}. Allowed: ${[...allowedHosts].join(', ')}`,
    );
  }
  const res = await fetch(url, {
    headers: { Accept: 'text/plain,*/*' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to download disposable list: HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error('Failed to download disposable list: empty body');
  }
  const mode = options.mode ?? 'replace';
  if (mode === 'merge') {
    return updateDisposableDomainsFromText(text, url);
  }
  return replaceDisposableDomainsFromText(text, url, { minCount: options.minCount });
}

/** Test helper — clear in-memory cache between suites. */
export function resetDisposableCache(): void {
  domainSet = null;
  meta = null;
}
