# Validation limitations — MailSure MCP

MailSure is a **self-hosted signal engine**, not a deliverability guarantee service.

## What results mean

| Signal | Meaning |
|--------|---------|
| `syntax_valid` | Address parses (RFC-aware; IDN/punycode supported). |
| `domain_exists` / `mx_exists` | DNS evidence the domain can receive mail (MX or A/AAAA fallback). |
| `overall_status: valid_domain` | Syntax OK **and** domain looks mail-capable. **Does not prove the mailbox exists.** |
| `disposable` / `is_role_based` | Local dataset / role-local heuristics. |
| `smtp_status` / `catch_all_status` | Optional probes; default **`not_checked`**. |

Full status table: [validation-statuses.md](./validation-statuses.md).

## Explicit non-guarantees

- No proof of individual mailbox existence when SMTP is off (default).
- Even with SMTP enabled: greylisting, tarpits, catch-alls, and anti-abuse policies make RCPT results inconclusive; status may be `unknown` / `temporary_error` / `risky`.
- DNS timeouts and temporary resolver failures map to `temporary_error` — **never treat as invalid**.
- Disposable list is a local snapshot; it can be stale until refreshed via `update_disposable_domains`.
- Catch-all detection is best-effort and disabled unless both catch-all **and** SMTP flags are enabled.

## SMTP policy

- `OPENVERIFY_SMTP_ENABLED` defaults to `false`.
- Probes never send mail (`MAIL FROM:<>` / RCPT only when enabled).
- Prefer leaving SMTP off for bulk CSV of third-party prospect lists.

## Optional remote Reacher SMTP

- Separate service (`eneelkant/reacher-render-deploy`); **not** merged into this repo.
- Opt-in via `REACHER_ENABLED` / `REACHER_API_URL` / `REACHER_TIMEOUT` (default off = unchanged behavior).
- Precedence: Reacher first; local SMTP only as fallback when Reacher fails **and** `OPENVERIFY_SMTP_ENABLED=true`.
- Failures/timeouts → `temporary_error` / `unknown` / overall `risky|unknown` — **never** false Invalid.
- Do not treat Reacher `is_reachable` as MailSure’s verdict.
- Nested Reacher SMTP errors (`smtp.error: { type, message }`, optional `description`) are accepted and mapped to `unknown` / `temporary_error` — not schema-mismatch Invalid.
- **Safe timeout:** sync `POST /v1/check_email` uses AbortController + Promise.race (`fetchWithSafeTimeout`). Default `REACHER_TIMEOUT=15000`, hard-capped at **60s**. Budget expiry → `REACHER_TIMEOUT` / `temporary_error` (request aborted; no hang). There is no separate Reacher job-poll API on this path — fail-soft within the budget is the async-safe client strategy.
- **SSRF posture:** `REACHER_API_URL` is operator env only (not request body). Origin-only http(s); credentials/paths rejected; link-local / cloud-metadata hosts blocked; outbound fetch uses `redirect: 'error'`. Private docker hostnames remain operator-controlled.
- Proxy/Socks5/`timed out`/`timeout`/IpBlacklisted alone never become false Invalid (`temporary_error` / `unknown` → overall `risky`/`unknown`).
- Render Free Reacher instances may **cold-start**; raise `REACHER_TIMEOUT` toward 60000 or use an always-on instance.
- Trial image quota (~10k/day) and anonymized metrics — see Reacher trial terms. Lower `OPENVERIFY_CONCURRENCY` when Reacher is enabled.

## Domain validity vs mailbox verification

```
valid_domain  ≠  mailbox verified
```

Use `valid_domain` for list hygiene (drop obvious junk domains / bad syntax / disposables). Do not market it as “confirmed deliverable inbox.”
