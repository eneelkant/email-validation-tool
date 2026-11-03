#!/usr/bin/env node
/**
 * Opt-in disposable domain dataset updater.
 * Usage:
 *   npm run update:disposable
 *   npm run update:disposable -- --url <https-url>
 */
import { loadConfig } from '../src/config/env.js';
import {
  updateDisposableDomainsFromUrl,
  getDisposableMeta,
  loadDisposableDomains,
} from '../src/validators/disposable.js';

const DEFAULT_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';

async function main(): Promise<void> {
  loadConfig();
  const idx = process.argv.indexOf('--url');
  const url = idx >= 0 ? process.argv[idx + 1] : DEFAULT_URL;
  if (!url) throw new Error('--url requires a value');
  // eslint-disable-next-line no-console
  console.error(`Updating disposable domains from ${url} ...`);
  const meta = await updateDisposableDomainsFromUrl(url);
  loadDisposableDomains(true);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ...meta, ...getDisposableMeta() }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
