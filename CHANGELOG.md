# Changelog

All notable changes to OpenVerify MCP will be documented in this file.

## [Unreleased]

### Added

- MailSure static website in `public/` (GitHub Pages) with verify UI, about, pricing, contact, privacy/terms drafts
- Optional verify-only website API (`OPENVERIFY_WEBSITE_API_ENABLED`): `POST /api/verify`, `POST /api/verify/batch`
- GitHub Actions workflow `deploy-pages.yml` for Pages deployment of `public/`
- Docs: `docs/mailsure-website.md`
- Frontend ValidationResult shape checks; Compose/env wiring for website API + CORS + SQLite volume paths
- Frontend/API tests for enable/disable, health, verify, batch, CORS, rate limits, invalid responses, CSV, duplicate banner

### Security

- HTTP auth fail-closed: non-loopback binds require `OPENVERIFY_HTTP_AUTH_TOKEN` before listen
- Docker Compose requires an explicit auth token via `.env` interpolation
- Website API off by default; separate rate/batch limits; does not expose MCP admin tools

### Fixed

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
