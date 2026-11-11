# Validation statuses and confidence

## `overall_status`

| Status | Meaning |
|--------|---------|
| `valid_domain` | Syntax OK; domain appears to exist with MX or A/AAAA mail fallback. **Does not prove the mailbox exists.** |
| `invalid_syntax` | Address failed syntax checks |
| `invalid_domain` | Domain does not exist (e.g. NXDOMAIN) |
| `no_mx` | Domain exists but no MX and no usable A/AAAA fallback |
| `disposable` | Domain matches local disposable dataset (and is **not** a free provider) |
| `risky` | Role-based, catch-all, or SMTP signals suggest elevated risk |
| `unknown` | Insufficient information (e.g. SMTP blocked) |
| `temporary_error` | Transient DNS/SMTP failure — **never treat as invalid** |

## Provider classification

After normalize, MailSure assigns a mutually exclusive `provider_type`:

| `provider_type` | Flags | UI label |
|-----------------|-------|----------|
| `disposable` | `is_disposable=true` | Disposable email address |
| `free` | `is_free_provider=true` | Free email provider |
| `custom` | both false | — (none) |
| `null` | both null | — (invalid syntax) |

Precedence: free providers win on overlap — **never** mark free/webmail domains (gmail, outlook, hotmail, yahoo, qq, …) as disposable. Free providers still follow normal DNS/SMTP overall status (typically `valid_domain`), they are not forced to `overall_status: disposable`.

## `confidence`

| Level | Typical use |
|-------|-------------|
| `high` | Strong local evidence (clear syntax failure, NXDOMAIN, disposable hit) |
| `medium` | Domain/MX look good or mixed risk signals |
| `low` | Temporary failures or inconclusive probes |

## SMTP / catch-all

- `smtp_status` and `catch_all_status` default to `not_checked` when disabled.
- SMTP never sends mail.
- Catch-all detection is best-effort and may return `unknown`.

## Optional Reacher SMTP → MailSure `smtp_status`

When `REACHER_ENABLED=true`, MailSure maps Reacher **`smtp.*` details** (not raw `is_reachable`) into `smtp_status`:

| Reacher signal | MailSure `smtp_status` |
|----------------|------------------------|
| `is_deliverable` + not disabled | `ok` |
| `is_disabled` / connected but not deliverable (non-catch-all) | `invalid` |
| `has_full_inbox` / cannot connect / HTTP timeout / 5xx / safe-timeout abort | `temporary_error` |
| Nested `smtp.error` (e.g. `AsyncSmtpError`) with transient message | `temporary_error` |
| Nested/flat SMTP CoreError (non-transient) / schema miss | `unknown` |

`is_reachable` may appear only as opaque reason codes (`REACHER_HINT_*`). It is **never** copied into `overall_status`.

## Product facet: Safe / Risky / Invalid / Unknown

MailSure-owned labels (docs / `classifyReachability` helper) derived from MailSure signals after SMTP mapping:

| Label | Typical MailSure signals |
|-------|--------------------------|
| **Safe** | Domain+MX OK, not disposable/role, `smtp_status: ok`, catch-all not yes |
| **Risky** | Disposable, role, catch-all, full inbox, or `smtp_status: temporary_error` / overall `risky` |
| **Invalid** | Bad syntax, NXDOMAIN, no MX; or definitive SMTP reject on the facet (`smtp_status: invalid`) — note `overall_status` still maps SMTP reject → `risky` (conservative API) |
| **Unknown** | Blocked/unknown SMTP, Reacher timeout without conclusive probe, insufficient signal |

Timeouts and Reacher outages must **not** become false Invalid.
