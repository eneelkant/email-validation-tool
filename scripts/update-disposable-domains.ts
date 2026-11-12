#!/usr/bin/env node
/**
 * Opt-in disposable domain dataset updater (fail-safe replace).
 *
 * Multi-source (default):
 *   npm run update:disposable
 *   npm run update:disposable -- --dry-run
 *
 * Single-URL (legacy / ops):
 *   npm run update:disposable -- --url <https-url>
 *   npm run update:disposable -- --url <https-url> --merge
 *
 * On download/parse/size failure the previous local file is left unchanged (exit 1).
 * Free email providers and upstream allowlist domains are never classified disposable.
 * Never overwrites data/free-email-providers.txt.
 */
import { loadConfig, getConfig } from '../src/config/env.js';
import {
  updateDisposableDomainsFromUrl,
  getDisposableMeta,
  loadDisposableDomains,
  DISPOSABLE_REPLACE_MIN_COUNT,
} from '../src/validators/disposable.js';
import {
  syncDisposableDomainsFromSources,
  DISPOSABLE_SYNC_MIN_COUNT,
  DISPOSABLE_SYNC_SOURCES,
} from '../src/validators/disposable-sync.js';
import { loadFreeProviders, getFreeProvidersMeta } from '../src/validators/free-provider.js';

const DEFAULT_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';

async function runSingleUrl(): Promise<void> {
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
          mode: 'single-url',
          disposable: { ...meta, ...getDisposableMeta() },
          free_providers: getFreeProvidersMeta(),
          free_providers_path: getConfig().freeProvidersPath,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          mode: 'single-url',
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

async function runMultiSource(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.error(
    `Multi-source disposable sync (sources=${DISPOSABLE_SYNC_SOURCES.length}, minCount=${DISPOSABLE_SYNC_MIN_COUNT}, dryRun=${dryRun}) ...`,
  );

  try {
    const result = await syncDisposableDomainsFromSources({ dryRun });
    console.error(JSON.stringify({ mode: 'multi-source', ...result }, null, 2));
    if (!result.ok) {
      process.exit(1);
    }
    if (!result.freeProvidersUnchanged) {
      console.error('ERROR: free-email-providers.txt changed unexpectedly');
      process.exit(1);
    }
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          mode: 'multi-source',
          error: err instanceof Error ? err.message : String(err),
          kept_existing: true,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  loadConfig();
  loadFreeProviders();

  if (process.argv.includes('--url') || process.argv.includes('--merge')) {
    await runSingleUrl();
    return;
  }
  await runMultiSource();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
