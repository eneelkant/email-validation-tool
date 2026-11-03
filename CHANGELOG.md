# Changelog

All notable changes to OpenVerify MCP will be documented in this file.

## [0.1.0] — 2026-11-03

### Added

- Initial OpenVerify MCP server implementation
- Validation engine: syntax, DNS/MX/A/AAAA, disposable domains, role-based locals
- Optional SMTP + catch-all diagnostics (disabled by default)
- SQLite caching, jobs, migrations
- MCP tools: `verify_email`, `verify_emails_batch`, `verify_csv`, `check_domain`, `get_validation_job`, `cancel_validation_job`, `get_statistics`, `clear_cache`, `update_disposable_domains`
- STDIO and Streamable HTTP transports
- Health endpoints: `/health`, `/ready`, `/version`
- Bulk CSV streaming pipeline with cancellation
- Client config examples for Cursor, Gemini CLI, Claude Desktop, ChatGPT remote
- Docker + Compose, GitHub Actions CI
- Security controls: Bearer auth, rate limits, path validation, CSV sanitization, SECURITY.md
