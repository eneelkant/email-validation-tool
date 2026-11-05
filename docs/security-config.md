# Security configuration — MailSure MCP

See also [SECURITY.md](../SECURITY.md) for the threat model and reporting process.

## HTTP authentication (fail-closed)

| Bind host (`OPENVERIFY_HTTP_HOST`) | Token (`OPENVERIFY_HTTP_AUTH_TOKEN`) |
|------------------------------------|--------------------------------------|
| `127.0.0.1`, `::1`, `localhost` | Optional (local development) |
| `0.0.0.0` or any non-loopback | **Required** — process exits before listen if empty |

- Missing/wrong Bearer on `/mcp` → **401** `{ "error": "unauthorized" }` (token never echoed).
- Health endpoints (`/health`, `/ready`, `/version`) stay unauthenticated and must not expose secrets.
- Docker Compose interpolates `${OPENVERIFY_HTTP_AUTH_TOKEN:?…}` so an unset token fails closed at compose time as well.

## Host / DNS-rebinding guards

- Set `OPENVERIFY_ALLOWED_HOSTS` to the hostnames you expect (default `127.0.0.1,localhost`).
- Invalid `Host` → **403**.
- `X-Forwarded-Host` must **not** bypass the allowlist (validated in tests).

## Abuse / DoS controls

| Control | Default / note |
|---------|----------------|
| JSON body limit | ~1 MiB (`jsonLimit: '1mb'` on the HTTP app; oversized bodies are rejected) |
| Rate limit | `OPENVERIFY_RATE_LIMIT_WINDOW_MS` (default 60000), `OPENVERIFY_RATE_LIMIT_MAX` (default 120) |
| CSV size | `OPENVERIFY_MAX_CSV_BYTES` (default 100 MiB) |
| CSV batch | `OPENVERIFY_CSV_BATCH_SIZE` capped at 1000 |
| Concurrency | `OPENVERIFY_CONCURRENCY` |

## CSV path allowlists

`verify_csv` resolves user paths with `assertSafeUserPath` (`src/security/paths.ts`). Paths must stay under one of the configured roots (resolved absolute paths; traversal outside the allowlist is rejected). From `src/processing/csv.ts`:

| Path role | Allowed roots |
|-----------|----------------|
| Input (`input_path`) | `OPENVERIFY_UPLOAD_DIR`, `OPENVERIFY_DATA_DIR`, process `cwd()` |
| Output (`output_path`, or default under the output dir) | `OPENVERIFY_OUTPUT_DIR`, `OPENVERIFY_DATA_DIR`, process `cwd()` |

This is broader than “upload/output only”: files under the data directory or the process working directory are accepted when they resolve inside those roots. It is **not** an open filesystem — paths that escape the allowlist fail. Prefer keeping CSVs under the configured upload/output directories in production.

## Logging & PII

- `OPENVERIFY_LOG_EMAILS=false` by default (redact addresses).
- Never log bearer tokens.

## Recommended remote deployment

1. Strong random `OPENVERIFY_HTTP_AUTH_TOKEN`.
2. Restrict `OPENVERIFY_ALLOWED_HOSTS`.
3. Terminate TLS at a reverse proxy; do not expose plain HTTP publicly.
4. Keep `OPENVERIFY_SMTP_ENABLED=false` unless you understand probe implications.
5. Mount only trusted data volumes in Docker.
