/**
 * Shared domain-set helpers for disposable / free-provider lists.
 */

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.$/, '').trim();
}

/** True if domain or any registrable parent is in the set. */
export function domainOrParentInSet(domain: string, set: Set<string>): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  if (set.has(d)) return true;
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (set.has(parent)) return true;
  }
  return false;
}

/** Parse newline-separated domain list text into a Set (comments/blank skipped). */
export function parseDomainListText(content: string): Set<string> {
  const domains = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim().toLowerCase().replace(/\.$/, '');
    if (!t || t.startsWith('#') || !t.includes('.')) continue;
    domains.add(t);
  }
  return domains;
}
