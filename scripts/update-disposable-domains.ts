#!/usr/bin/env node
/**
 * Opt-in disposable domain dataset updater (fail-safe replace).
 * Usage:
 *   npm run update:disposable
 *   npm run update:disposable -- --url <https-url>
 *   npm run update:disposable -- --merge
 *
 * On download/parse/size failure the previous local file is left unchanged (exit 1).
 * Free email providers are stripped from the disposable file and never classified as disposable.
 */
import { loadConfig } from '../src/config/env.js';
import {
  updateDisposableDomainsFromUrl,
  getDisposableMeta,
  loadDisposableDomains,
  DISPOSABLE_REPLACE_MIN_COUNT,
} from '../src/validators/disposable.js';
import { loadFreeProviders, getFreeProvidersMeta } from '../src/validators/free-provider.js';

const DEFAULT_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';

async function main(): Promise<void> {
  loadConfig();
  loadFreeProviders();

  const idx = process.argv.indexOf('--url');
  const url = idx >= 0 ? process.argv[idx + 1] : DEFAULT_URL;
  if (!url) throw new Error('--url requires a value');

  const merge = process.argv.includes('--merge');
  const mode = merge ? 'merge' : 'replace';

  console.error(
    `Updating disposable domains from ${url} (mode=${mode}, minCount=${DISPOSABLE_REPLACE_MIN_COUNT}) ...`,
  );

  try {
    const meta = await updateDisposableDomainsFromUrl(url, {
      mode,
      minCount: DISPOSABLE_REPLACE_MIN_COUNT,
    });
    loadDisposableDomains(true);
    console.error(
      JSON.stringify(
        {
          ok: true,
          disposable: { ...meta, ...getDisposableMeta() },
          free_providers: getFreeProvidersMeta(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    // Fail-safe: do not wipe the existing dataset.
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          kept_existing: true,
          disposable: (() => {
            try {
              loadDisposableDomains(true);
              return getDisposableMeta();
            } catch {
              return null;
            }
          })(),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
