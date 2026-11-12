# MailSure MCP

**Free, open-source, self-hosted email verification** for local validation, bounded bulk CSV processing, DNS/MX checks, and disposable-email detection — without paid API credits.

**MailSure** (*Email Verification Made Simple.*) is the product name for the website, MCP server, and optional verify API. The npm package/bin and `OPENVERIFY_*` environment variable names are kept for compatibility with existing configs.

> Repository: [eneelkant/email-validation-tool](https://github.com/eneelkant/email-validation-tool)  
> Website: [eneelkant.github.io/email-validation-tool](https://eneelkant.github.io/email-validation-tool/) (after Pages workflow succeeds on `main`)  
> License: GPL-3.0

## What it does

| Capability | Notes |
|------------|--------|
| Syntax validation | RFC-aware, IDN/punycode, preserves original address |
| DNS / MX / A / AAAA | Timeouts ≠ invalid |
| Disposable detection | Local dataset (not fetched per request); optional multi-source fail-safe sync + daily automation PR |
| Free provider detection | Curated list (gmail/outlook/yahoo/qq/…); never marked disposable |
| Role-based locals | Configurable list (`admin@`, `info@`, …) |
| Optional SMTP / catch-all | **Off by default**; never sends mail; no deliverability guarantee |
| Caching + jobs | SQLite |
| Bulk CSV | Bounded-memory streaming batches, concurrent, cancellable (size-capped) |
| MCP tools | 9 tools over STDIO + Streamable HTTP |

**Important:** `valid_domain` means the domain looks mail-capable. It does **not** mean the individual mailbox was confirmed.

## Requirements

- Node.js **22+**
- Optional: Docker
- Optional: [Render](docs/render-deploy.md) for hosting `mailsure-api`

## Quick start (STDIO)

```bash
npm install
npm run build
node dist/index.js --transport stdio
```

Point your MCP client at that command (see [Client setup](#client-setup)). MCP `serverInfo.name` is `mailsure-mcp`.

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
- `GET /health`, `GET /ready`, `GET /version` — liveness only; no secrets (`service: mailsure-api`, product MailSure MCP)
- Optional website API: `POST /api/verify`, `POST /api/verify/batch` (when enabled)

Remote exposure also needs **HTTPS** (Render or a reverse proxy) and a strong token. Cloud hosts that inject `PORT` are supported; `OPENVERIFY_HTTP_PORT` remains the local/Docker default.

## Docker

```bash
# Required: set a token (Compose fails if OPENVERIFY_HTTP_AUTH_TOKEN is unset)
echo 'OPENVERIFY_HTTP_AUTH_TOKEN=change-me-to-a-long-random-value' >> .env
docker compose up --build
```

Data persists in the `openverify-data` volume. Do not bake secrets into the image. Image/compose are provided for deployment convenience; treat remote use as requiring auth + TLS review.

## Render (mailsure-api)

Blueprint: [`render.yaml`](render.yaml). Operator steps: [docs/render-deploy.md](docs/render-deploy.md).

- Web service name: **mailsure-api** (Docker, branch `main`, health `/health`)
- Enables website API + CORS for `https://eneelkant.github.io`
- Generates `OPENVERIFY_HTTP_AUTH_TOKEN`; you must set `OPENVERIFY_ALLOWED_HOSTS` to include the real Render hostname
- **Free-tier / no disk:** SQLite retained for in-process caches + MCP CSV jobs under ephemeral `/data` (`OPENVERIFY_EPHEMERAL_STORAGE=true`; wiped on redeploy). Optional `OPENVERIFY_DB_PATH=:memory:`. Website bulk CSV remains client-side.
- **Enzonic / Lambda (`/var/task`):** with `OPENVERIFY_EPHEMERAL_STORAGE=true`, paths under the read-only package root remap to `os.tmpdir()` (no `mkdir` under `/var/task`). See [docs/mailsure-website.md](docs/mailsure-website.md#enzonic-deploy-website-api--cors).

**Do not invent a Render/Enzonic URL.** Leave [`public/js/config.js`](public/js/config.js) `API_BASE_URL` empty until you have confirmed `GET /health` on the HTTPS origin your host assigns. This repository does not claim a live backend deploy.

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
| Cursor | [`.cursor/mcp.json`](.cursor/mcp.json) (server alias `mailsure`) |
| Gemini CLI | [`.gemini/settings.json`](.gemini/settings.json) (server alias `mailsure`) |
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

See [`.env.example`](.env.example). Key variables (names keep the `OPENVERIFY_` prefix for compatibility):

- `OPENVERIFY_TRANSPORT` — `stdio` \| `http` \| `both` (STDIO needs no HTTP token)
- `OPENVERIFY_HTTP_HOST` — default `127.0.0.1` (loopback); `0.0.0.0` requires auth token
- `OPENVERIFY_HTTP_PORT` — local/Docker listen port (default `8787`); overridden by platform `PORT` when set (e.g. Render)
- `OPENVERIFY_HTTP_AUTH_TOKEN` — Bearer for MCP; required for non-loopback HTTP
- `OPENVERIFY_CSV_BATCH_SIZE` — streaming batch size (default 100, cap 1000)
- `OPENVERIFY_MAX_CSV_BYTES` — max CSV bytes accepted (default 100 MiB)
- `OPENVERIFY_CONCURRENCY` — validation concurrency
- `OPENVERIFY_SMTP_ENABLED` — default `false`
- `OPENVERIFY_LOG_EMAILS` — default `false` (redact emails in logs)
- `OPENVERIFY_WEBSITE_API_ENABLED` — default `false`; verify-only REST for MailSure Pages

CSV jobs stream in bounded batches (read → parse → batch → validate → ordered write), support cancellation, preserve row order/columns, and sanitize formula-like cells. Cancellation stops new batches, flushes completed output, and marks the job `cancelled`.

## MailSure website (GitHub Pages)

Static site sources live in [`public/`](public/). Workflow: [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).

1. Repo **Settings → Pages → Source: GitHub Actions**
2. Merge to `main` (or run the workflow manually after merge)
3. Confirm the **Deploy MailSure Pages** Action is green before treating the site as live

By default the Pages build has an empty `API_BASE_URL` in [`public/js/config.js`](public/js/config.js) — the UI shows a **single** backend-unavailable banner and **never invents results**. To power browser verify:

1. Host `mailsure-api` (Render Blueprint or self-hosted HTTP) with `OPENVERIFY_TRANSPORT=http`, `OPENVERIFY_WEBSITE_API_ENABLED=true`, and `OPENVERIFY_CORS_ORIGINS=https://eneelkant.github.io`.
2. Confirm `GET /health` reports `"website_api": true`.
3. Set `API_BASE_URL` in `public/js/config.js` to that **real** origin only.

There is no invented cloud URL in this repo — leave `API_BASE_URL` empty until you operate a backend. MCP is **not** exposed as public REST; the optional website API is verify-only (`/api/verify`, `/api/verify/batch`) plus existing `/health`. Full steps: [docs/mailsure-website.md](docs/mailsure-website.md).

## Documentation

- [MailSure website](docs/mailsure-website.md)
- [Render deploy (mailsure-api)](docs/render-deploy.md)
- [Architecture](docs/architecture.md)
- [MCP client setup](docs/mcp-client-setup.md)
- [Security configuration](docs/security-config.md)
- [Validation statuses](docs/validation-statuses.md)
- [Validation limitations](docs/validation-limitations.md)
- [Disposable domain sync](docs/disposable-domain-sync.md)
- [Bulk CSV](docs/bulk-csv.md)
- [Troubleshooting](docs/troubleshooting.md)
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
