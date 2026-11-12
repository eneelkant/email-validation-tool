# Changelog

All notable changes to MailSure MCP will be documented in this file.

## [Unreleased]

### Added

- Daily multi-source disposable domain sync: unions DED blocklist (+ allowlist), disposable/disposable-email-domains (`domains` / strict / json), FGRibreau/mailchecker `list.txt`, and ivolo exact+wildcard JSON; parses/normalizes/validates; wildcards stored as apex for parent match; allowlist + free providers excluded; atomic publish with fail-safe min-count / shrink-ratio; never overwrites `free-email-providers.txt`; no per-request remote fetch
- GitHub Action `.github/workflows/update-disposable-domains.yml` (daily + `workflow_dispatch`) opens an automation PR — does not push `main` and does not auto-merge
- Disposable vs free email provider classification: `is_free_provider`, `provider_type` (`disposable` \| `free` \| `custom`) on ValidationResult / domain check / CSV / website UI / MCP; UI labels “Disposable email address” / “Free email provider”
- Curated `data/free-email-providers.txt` + `OPENVERIFY_FREE_PROVIDERS_PATH` (gmail/outlook/hotmail/yahoo/qq and more); free providers are never marked disposable
- Fail-safe disposable refresh (`npm run update:disposable`); no per-request download
- Optional remote Reacher SMTP provider (`REACHER_ENABLED` / `REACHER_API_URL` / `REACHER_TIMEOUT`): orchestrator calls separate `POST /v1/check_email` after DNS; maps `smtp.*` into MailSure statuses; never uses raw `is_reachable` as verdict; local SMTP remains fallback; failures/timeouts stay temporary/unknown (not false Invalid)
- Reacher response parsing accepts nested `smtp.error` (and flat CoreError); sync calls use AbortController + Promise.race safe timeout (default 15s, max 60s)
- Render Blueprint `render.yaml` for Web Service **mailsure-api** (Docker, health `/health`, website API + Pages CORS, free-tier **no persistent disk** / ephemeral `/data`, secrets via Render)
- `OPENVERIFY_EPHEMERAL_STORAGE` + optional `OPENVERIFY_DB_PATH=:memory:`; CSV upload cleanup after MCP jobs; `/health` reports `storage` / `db`
- Docs: `docs/render-deploy.md` (Blueprint creation steps; no invented Render URL)
- Platform `PORT` preferred over `OPENVERIFY_HTTP_PORT` for cloud hosts (Render)
- MailSure static website in `public/` (GitHub Pages) with verify UI, about, pricing, contact, privacy/terms drafts
- Optional verify-only website API (`OPENVERIFY_WEBSITE_API_ENABLED`): `POST /api/verify`, `POST /api/verify/batch`
- GitHub Actions workflow `deploy-pages.yml` for Pages deployment of `public/`
- Docs: `docs/mailsure-website.md` / `docs/disposable-domain-sync.md`
- Frontend ValidationResult shape checks; Compose/env wiring for website API + CORS + SQLite volume paths
- Frontend/API tests for enable/disable, health, verify, batch, CORS, rate limits, invalid responses, CSV, duplicate banner

### Changed

- `npm run update:disposable` defaults to multi-source sync (`--url` retains single-source replace/merge; `--dry-run` supported)
- Replaced weekly `refresh-disposable-domains.yml` with daily `update-disposable-domains.yml`
- User-facing product/MCP identity rebranded to **MailSure MCP** (`serverInfo.name` = `mailsure-mcp`; health `service` = `mailsure-api`)
- `OPENVERIFY_*` env keys, API paths, DB filenames, npm package/bin, and import helpers kept for compatibility
- Client example aliases renamed to `mailsure` (Cursor / Gemini / Claude)

### Security

- HTTP auth fail-closed: non-loopback binds require `OPENVERIFY_HTTP_AUTH_TOKEN` before listen
- Docker Compose requires an explicit auth token via `.env` interpolation
- Website API off by default; separate rate/batch limits; does not expose MCP admin tools

### Fixed

- Free-provider blank CSV/API fields: rehydrate stale cache / legacy payloads missing `is_free_provider` / `provider_type` (including valid-syntax null / partial null); Docker sets `OPENVERIFY_FREE_PROVIDERS_PATH`; empty free-provider file falls back to seed; `/health` reports `free_providers` + `classification_schema`; frontend rejects responses omitting provider fields
- Ephemeral storage on Enzonic/Lambda: `OPENVERIFY_EPHEMERAL_STORAGE=true` remaps `/var/task` (and `/var/runtime`) paths to `os.tmpdir()` so startup never `mkdir`s under the read-only package root; Render `/data` and local paths unchanged
- HTTP transport binds and serves `/health` before SQLite/disposable init; `/ready` and DB-dependent `/api` + MCP routes stay 503 until ready (or degraded on init failure)
- Cloud `PORT` without explicit `OPENVERIFY_HTTP_HOST` binds `0.0.0.0` (local default stays `127.0.0.1` when `PORT` unset)
- CSV validation uses bounded-memory streaming batches (no full-file row array)
- HTTP tests assert successful MCP initialize structure and Host-header rejection
- MailSure duplicate “backend unavailable” warning: connection state stays on `#backend-status`; `#verify-feedback` is form-only
- Browser Origin allowlisting for website API: derive hostnames from `OPENVERIFY_CORS_ORIGINS` for MCP Origin guard (full URLs previously caused 403 Invalid Origin)

### Changed

- Documented remote HTTPS + token requirements; CSV batch/size limits and cancellation behavior
- `/health` and `/version` include `website_api` flag when reporting status
- HTTP listen logs include `website_api` and CORS origin count

## [0.1.0] — 2026-11-03

### Added

- Initial OpenVerify MCP server implementation
- Validation engine: syntax, DNS/MX/A/AAAA, disposable domains, role-based locals
- Optional SMTP + catch-all diagnostics (disabled by default)
- SQLite caching, jobs, migrations
- MCP tools: `verify_email`, `verify_emails_batch`, `verify_csv`, `check_domain`, `get_validation_job`, `cancel_validation_job`, `get_statistics`, `clear_cache`, `update_disposable_domains`
- STDIO and Streamable HTTP transports
- Health endpoints: `/health`, `/ready`, `/version`
- Bulk CSV pipeline with cancellation
- Client config examples for Cursor, Gemini CLI, Claude Desktop, ChatGPT remote
- Docker + Compose, GitHub Actions CI
- Security controls: Bearer auth, rate limits, path validation, CSV sanitization, SECURITY.md
