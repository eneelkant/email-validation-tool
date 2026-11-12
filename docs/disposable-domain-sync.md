# Disposable domain sync

MailSure classifies disposable domains from a **vendored local snapshot** (`data/disposable-domains.txt`). Validation requests never download remote lists.

## Refresh

```bash
# Multi-source fail-safe replace (default)
npm run update:disposable

# Validate thresholds without writing
npm run update:disposable -- --dry-run

# Single allowlisted HTTPS URL (legacy / ops)
npm run update:disposable -- --url https://raw.githubusercontent.com/...
```

GitHub Action: `.github/workflows/update-disposable-domains.yml` (daily + `workflow_dispatch`) runs the sync and opens an automation PR. It does **not** push `main` and does **not** auto-merge.

## Sources

| Group | Upstream | Artifacts |
|-------|----------|-----------|
| A | disposable-email-domains/disposable-email-domains | Blocklist; allowlist when present (tip removed 2026-04 — sync falls back to last known commit) |
| B | disposable/disposable-email-domains | `domains.txt`, `domains_strict.txt`, `domains.json` |
| C | FGRibreau/mailchecker | `list.txt` |
| D | ivolo/disposable-email-domains | `index.json` (exact), `wildcard.json` (apex / `*.` → parent match) |

## Guarantees

- Parse → normalize → validate; reject malformed entries
- Wildcards stored as apex domains; runtime parent matching covers subdomains
- Upstream allowlist ∪ curated free providers are **never** written as disposable
- `data/free-email-providers.txt` is **never** overwritten by sync
- Atomic publish (temp → rename); abort if absolute min count or shrink-ratio checks fail
- Per-source soft-fail; publish aborts if no blocklist data survives
