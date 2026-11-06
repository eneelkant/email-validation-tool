import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfig, isReadonlyDeployPath } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

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
  const domains = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().toLowerCase();
    if (!t || t.startsWith('#')) continue;
    domains.add(t.replace(/\.$/, ''));
  }
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

export function isDisposableDomain(domain: string): boolean {
  const set = loadDisposableDomains();
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (set.has(d)) return true;
  // Check parent domains (e.g. mail.mailinator.com)
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (set.has(parent)) return true;
  }
  return false;
}

/**
 * Merge remote or local list content into the dataset file (deduped).
 * Does not download automatically on every validation — call explicitly via tool/script.
 */
export function updateDisposableDomainsFromText(
  content: string,
  sourceLabel = 'manual-update',
): DisposableDatasetMeta {
  const file = ensureDisposableDatasetFile();
  const existing = loadDisposableDomains(true);
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim().toLowerCase().replace(/\.$/, '');
    if (!t || t.startsWith('#') || !t.includes('.')) continue;
    existing.add(t);
  }
  const sorted = [...existing].sort();
  const now = new Date().toISOString();
  const body = [
    '# MailSure MCP disposable domain dataset',
    `# Source: ${sourceLabel}`,
    `# Updated: ${now}`,
    '# One domain per line. Lines starting with # are comments.',
    '',
    ...sorted,
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  domainSet = null;
  meta = null;
  return getDisposableMeta();
}

/**
 * Fetch a public disposable domain list (opt-in). Documented sources only.
 */
export async function updateDisposableDomainsFromUrl(
  url: string,
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to download disposable list: HTTP ${res.status}`);
  }
  const text = await res.text();
  return updateDisposableDomainsFromText(text, url);
}
