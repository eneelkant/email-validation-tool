# Architecture

MailSure MCP is a modular TypeScript service (product identity **MailSure**; env keys remain `OPENVERIFY_*`):

```
src/
  config/       Environment + defaults
  validators/   Syntax, DNS, disposable, role, SMTP, catch-all, orchestrator
  database/     SQLite + versioned migrations
  processing/   Batch + CSV jobs
  mcp/          MCP server factory + tools + STDIO
  http/         Express app, health, optional MailSure website API, Streamable HTTP MCP
  security/     Auth, path, CSV, host guards
  types/        Shared Zod schemas
  utils/        Logger, concurrency
public/         MailSure static site (GitHub Pages)
```

## Transports

- **STDIO** — local MCP clients (Cursor, Claude Desktop/Code, Gemini CLI). Logs → stderr only. No HTTP auth.
- **Streamable HTTP** — remote MCP via official SDK (`createMcpHandler` + Express). Endpoint default `/mcp`.
  - Loopback bind: token optional.
  - Non-loopback bind: token mandatory (startup fail-closed).

## CSV pipeline

Bounded-memory streaming:

`CSV Read Stream → CSV Parser → Bounded Batch Buffer → Email Validation → Ordered CSV Writer`

- Configurable `OPENVERIFY_CSV_BATCH_SIZE` (capped at 1000).
- Preserves input row order and original columns; appends validation columns.
- Respects write backpressure; supports cancellation between batches.
- File size limited by `OPENVERIFY_MAX_CSV_BYTES` (not unlimited).

## Persistence

SQLite stores validation/domain caches, jobs, errors, settings. CSV inputs/outputs stay on the filesystem under configured directories (not embedded in SQLite). Auth tokens are env-only (never in SQLite).

On free-tier Render (`OPENVERIFY_EPHEMERAL_STORAGE=true`, no persistent disk) the same SQLite schema runs on the container filesystem or `:memory:` — data lasts for the process/instance only and is wiped on redeploy. MCP CSV uploads under the upload directory are deleted after the job finishes. Website single/bulk verify does not need durable storage (browser CSV parse + `/api/verify/batch` + client download).

## Extension

The validation orchestrator is transport-agnostic. The optional MailSure website API (`OPENVERIFY_WEBSITE_API_ENABLED`) mounts verify-only routes that call the same engine without exposing MCP admin tools. See [mailsure-website.md](mailsure-website.md).
