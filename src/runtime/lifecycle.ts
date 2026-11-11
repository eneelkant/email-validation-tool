/**
 * Process runtime lifecycle for HTTP readiness.
 * Allows binding the HTTP listener before SQLite/disposable init completes,
 * while preventing DB-dependent routes from racing initialization.
 */
import { getDb } from '../database/db.js';
import { getLogger } from '../utils/logger.js';
import { loadDisposableDomains } from '../validators/disposable.js';
import { loadFreeProviders } from '../validators/free-provider.js';

const log = getLogger('lifecycle');

export type DbStatus = 'initializing' | 'ready' | 'failed';
export type HealthStatus = 'starting' | 'ok' | 'degraded';

export type RuntimeLifecycle = {
  dbStatus: DbStatus;
  /** Present only when dbStatus === 'failed' — never includes secrets/paths. */
  failureCode?: 'init_failed';
};

/**
 * Default ready so unit tests that open the DB before createHttpApp stay compatible.
 * Production HTTP path calls beginRuntimeInitialization() before listen.
 */
let dbStatus: DbStatus = 'ready';
let initCompleted = false;
let initPromise: Promise<void> | null = null;

export function getRuntimeLifecycle(): RuntimeLifecycle {
  return {
    dbStatus,
    ...(dbStatus === 'failed' ? { failureCode: 'init_failed' as const } : {}),
  };
}

export function getHealthStatus(): HealthStatus {
  if (dbStatus === 'initializing') return 'starting';
  if (dbStatus === 'failed') return 'degraded';
  return 'ok';
}

export function isRuntimeReady(): boolean {
  return dbStatus === 'ready';
}

/** Mark initializing before HTTP listen (Enzonic cold-start safe path). */
export function beginRuntimeInitialization(): void {
  dbStatus = 'initializing';
  initCompleted = false;
  initPromise = null;
}

/**
 * Initialize SQLite + disposable / free-provider datasets once.
 * Safe to call concurrently — shares a single in-flight promise.
 */
export async function initializeRuntime(): Promise<void> {
  if (initCompleted && dbStatus === 'ready') {
    return;
  }
  if (initPromise) return initPromise;

  dbStatus = 'initializing';

  initPromise = (async () => {
    try {
      getDb();
      // Free providers first so disposable classification can exclude them.
      loadFreeProviders();
      loadDisposableDomains();
      dbStatus = 'ready';
      initCompleted = true;
      log.info({ db_status: dbStatus }, 'Runtime initialization complete');
    } catch (err) {
      dbStatus = 'failed';
      initCompleted = false;
      log.error({ err }, 'Runtime initialization failed');
      throw err;
    }
  })();

  return initPromise;
}

/** Test helper — reset lifecycle between suites. */
export function resetRuntimeLifecycle(next: DbStatus = 'ready'): void {
  dbStatus = next;
  initCompleted = next === 'ready';
  initPromise = null;
}
