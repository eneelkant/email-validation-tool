import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfig, isReadonlyDeployPath } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { domainOrParentInSet } from './domain-set.js';

const log = getLogger('free-provider');

export type FreeProviderDatasetMeta = {
  version: string;
  updated_at: string;
  count: number;
  source: string;
};

let domainSet: Set<string> | null = null;
let meta: FreeProviderDatasetMeta | null = null;

/** Curated consumer webmail seeds — never classified as disposable. */
const DEFAULT_SEED = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'qq.com',
  '163.com',
  '126.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'mail.ru',
];

export function ensureFreeProvidersDatasetFile(): string {
  const cfg = getConfig();
  const file = cfg.freeProvidersPath;
  if (existsSync(file)) {
    return file;
  }
  if (isReadonlyDeployPath(file)) {
    throw new Error(
      `Free providers dataset missing under read-only deploy path: ${file}. ` +
        `Enable OPENVERIFY_EPHEMERAL_STORAGE or set OPENVERIFY_FREE_PROVIDERS_PATH to a writable file.`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const header = [
    '# MailSure MCP free email provider dataset',
    '# Source: curated local seed (not downloaded per request)',
    `# Updated: ${new Date().toISOString()}`,
    '# One domain per line. Lines starting with # are comments.',
    '# Free providers are never classified as disposable.',
    '',
    ...DEFAULT_SEED,
    '',
  ].join('\n');
  writeFileSync(file, header, 'utf8');
  log.info({ file, count: DEFAULT_SEED.length }, 'Wrote seed free email provider dataset');
  return file;
}

export function loadFreeProviders(force = false): Set<string> {
  if (domainSet && !force) return domainSet;
  const file = ensureFreeProvidersDatasetFile();
  const text = readFileSync(file, 'utf8');
  const domains = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().toLowerCase();
    if (!t || t.startsWith('#')) continue;
    domains.add(t.replace(/\.$/, ''));
  }
  // Never serve an empty free-provider set — majors would silently classify as custom
  // and CSV/UI would look "blank" relative to expected free labels after a bad package.
  if (domains.size === 0) {
    for (const d of DEFAULT_SEED) domains.add(d);
    log.warn(
      { file, seed: DEFAULT_SEED.length },
      'Free providers file empty; using in-process DEFAULT_SEED fallback',
    );
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
  log.info({ count: domains.size, version: hash }, 'Loaded free email providers');
  return domains;
}

export function getFreeProvidersMeta(): FreeProviderDatasetMeta {
  if (!meta) loadFreeProviders();
  return meta!;
}

export function isFreeProviderDomain(domain: string): boolean {
  return domainOrParentInSet(domain, loadFreeProviders());
}

/**
 * Merge domains into the free-provider file (deduped). Opt-in / tests only —
 * free list is curated and not fetched on every validation.
 */
export function updateFreeProvidersFromText(
  content: string,
  sourceLabel = 'manual-update',
): FreeProviderDatasetMeta {
  const file = ensureFreeProvidersDatasetFile();
  const existing = loadFreeProviders(true);
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim().toLowerCase().replace(/\.$/, '');
    if (!t || t.startsWith('#') || !t.includes('.')) continue;
    existing.add(t);
  }
  const sorted = [...existing].sort();
  const now = new Date().toISOString();
  const body = [
    '# MailSure MCP free email provider dataset',
    `# Source: ${sourceLabel}`,
    `# Updated: ${now}`,
    '# One domain per line. Lines starting with # are comments.',
    '# Free providers are never classified as disposable.',
    '',
    ...sorted,
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  domainSet = null;
  meta = null;
  return getFreeProvidersMeta();
}

/** Test helper — clear in-memory cache between suites. */
export function resetFreeProvidersCache(): void {
  domainSet = null;
  meta = null;
}
