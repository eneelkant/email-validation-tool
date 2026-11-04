import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type SafePathOptions = {
  mustExist?: boolean;
  allowedRoots: string[];
};

/**
 * Resolve a user-supplied path and ensure it stays within allowed roots.
 * Protects against path traversal.
 */
export function assertSafeUserPath(input: string, options: SafePathOptions): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Path is required');
  }
  if (input.includes('\0')) {
    throw new Error('Invalid path');
  }

  const resolved = path.resolve(input);
  const roots = options.allowedRoots.map((r) => path.resolve(r));

  const exists = existsSync(resolved);
  if (options.mustExist && !exists) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  let candidate = resolved;
  if (exists) {
    try {
      const st = statSync(resolved);
      candidate = st.isSymbolicLink?.() ? realpathSync(resolved) : realpathSync(resolved);
    } catch {
      candidate = realpathSync(resolved);
    }
  } else {
    // Ensure parent is within roots
    const parent = path.dirname(resolved);
    if (!existsSync(parent)) {
      // allow creating under an allowed root that already exists
      const underRoot = roots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      );
      if (!underRoot) throw new Error('Path escapes allowed directories');
      return resolved;
    }
    candidate = path.join(realpathSync(parent), path.basename(resolved));
  }

  const ok = roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
  if (!ok) {
    throw new Error('Path escapes allowed directories');
  }
  return candidate;
}
