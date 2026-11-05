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

## Domain validity vs mailbox verification

```
valid_domain  ≠  mailbox verified
```

Use `valid_domain` for list hygiene (drop obvious junk domains / bad syntax / disposables). Do not market it as “confirmed deliverable inbox.”
