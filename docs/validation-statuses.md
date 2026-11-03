# Validation statuses and confidence

## `overall_status`

| Status | Meaning |
|--------|---------|
| `valid_domain` | Syntax OK; domain appears to exist with MX or A/AAAA mail fallback. **Does not prove the mailbox exists.** |
| `invalid_syntax` | Address failed syntax checks |
| `invalid_domain` | Domain does not exist (e.g. NXDOMAIN) |
| `no_mx` | Domain exists but no MX and no usable A/AAAA fallback |
| `disposable` | Domain matches local disposable dataset |
| `risky` | Role-based, catch-all, or SMTP signals suggest elevated risk |
| `unknown` | Insufficient information (e.g. SMTP blocked) |
| `temporary_error` | Transient DNS/SMTP failure — **never treat as invalid** |

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
