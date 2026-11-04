# OpenVerify MCP

**Free, open-source, self-hosted email verification MCP server** for local validation, bounded bulk CSV processing, DNS/MX checks, and disposable-email detection — without paid API credits.

> Repository: [eneelkant/email-validation-tool](https://github.com/eneelkant/email-validation-tool)  
> License: GPL-3.0

## What it does

| Capability | Notes |
|------------|--------|
| Syntax validation | RFC-aware, IDN/punycode, preserves original address |
| DNS / MX / A / AAAA | Timeouts ≠ invalid |
| Disposable detection | Local dataset (not fetched per request) |
| Role-based locals | Configurable list (`admin@`, `info@`, …) |
| Optional SMTP / catch-all | **Off by default**; never sends mail; no deliverability guarantee |
| Caching + jobs | SQLite |
| Bulk CSV | Bounded-memory streaming batches, concurrent, cancellable (size-capped) |
| MCP tools | 9 tools over STDIO + Streamable HTTP |

**Important:** `valid_domain` means the domain looks mail-capable. It does **not** mean the individual mailbox was confirmed.

## Requirements

- Node.js **22+**
- Optional: Docker

## Quick start (STDIO)

```bash
npm install
npm run build
node dist/index.js --transport stdio
```

Point your MCP client at that command (see [Client setup](#client-setup)).

## Quick start (HTTP)

```bash
cp .env.example .env
# Loopback (default OPENVERIFY_HTTP_HOST=127.0.0.1): token optional
# Non-loopback (e.g. 0.0.0.0): OPENVERIFY_HTTP_AUTH_TOKEN is mandatory or startup fails
npm run build
node dist/index.js --transport http
```

Endpoints:

- MCP: `POST /mcp` (Streamable HTTP) — Bearer auth when token configured / required
- `GET /health`, `GET /ready`, `GET /version` — liveness only; no secrets

Remote exposure also needs **HTTPS** (terminate TLS at a reverse proxy) and a strong token.

## Docker

```bash
# Required: set a token (Compose fails if OPENVERIFY_HTTP_AUTH_TOKEN is unset)
echo 'OPENVERIFY_HTTP_AUTH_TOKEN=change-me-to-a-long-random-value' >> .env
docker compose up --build
```

Data persists in the `openverify-data` volume. Do not bake secrets into the image. Image/compose are provided for deployment convenience; treat remote use as requiring auth + TLS review.

## MCP tools

1. `verify_email`
2. `verify_emails_batch`
3. `verify_csv`
4. `check_domain`
5. `get_validation_job`
6. `cancel_validation_job`
7. `get_statistics`
8. `clear_cache`
9. `update_disposable_domains`

## Client setup

Examples ship in-repo. **Tested in this project’s CI/unit suite for transports and health/auth;** end-to-end verification inside each proprietary client UI depends on your local install and that client’s current MCP support — do not assume automatic compatibility.

| Client | Config |
|--------|--------|
| Cursor | [`.cursor/mcp.json`](.cursor/mcp.json) |
| Gemini CLI | [`.gemini/settings.json`](.gemini/settings.json) (server alias `openverify`) |
| Claude Desktop / Code | [`examples/claude-desktop-config.json`](examples/claude-desktop-config.json) |
| ChatGPT (remote) | [`examples/chatgpt-remote.md`](examples/chatgpt-remote.md) |

After `npm run build`, Cursor/Gemini can use:

```json
{
  "command": "node",
  "args": ["dist/index.js", "--transport", "stdio"]
}
```

(Use an absolute path in Claude Desktop.)

## Configuration

See [`.env.example`](.env.example). Key variables:

- `OPENVERIFY_TRANSPORT` — `stdio` \| `http` \| `both` (STDIO needs no HTTP token)
- `OPENVERIFY_HTTP_HOST` — default `127.0.0.1` (loopback); `0.0.0.0` requires auth token
- `OPENVERIFY_HTTP_AUTH_TOKEN` — Bearer for MCP; required for non-loopback HTTP
- `OPENVERIFY_CSV_BATCH_SIZE` — streaming batch size (default 100, cap 1000)
- `OPENVERIFY_MAX_CSV_BYTES` — max CSV bytes accepted (default 100 MiB)
- `OPENVERIFY_CONCURRENCY` — validation concurrency
- `OPENVERIFY_SMTP_ENABLED` — default `false`
- `OPENVERIFY_LOG_EMAILS` — default `false` (redact emails in logs)

CSV jobs stream in bounded batches (read → parse → batch → validate → ordered write), support cancellation, preserve row order/columns, and sanitize formula-like cells. Cancellation stops new batches, flushes completed output, and marks the job `cancelled`.

## Documentation

- [Architecture](docs/architecture.md)
- [Validation statuses](docs/validation-statuses.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Benchmarks

Support for large CSVs (1k / 10k / 100k) is implemented via streaming + concurrency. **No fabricated throughput numbers are published here** — measure on your hardware with `verify_csv` and report real results if you open a PR.

## Security

See [SECURITY.md](SECURITY.md). No paid verification APIs. No automatic CSV uploads. No outbound email.
