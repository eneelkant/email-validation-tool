import { getConfig } from '../config/env.js';

export function isRoleBasedLocalPart(local: string, extra: string[] = []): boolean {
  const cfg = getConfig();
  const set = new Set(
    [...cfg.roleLocalParts, ...extra].map((s) => s.toLowerCase()),
  );
  const base = local.toLowerCase().split('+')[0] ?? local.toLowerCase();
  return set.has(base);
}
