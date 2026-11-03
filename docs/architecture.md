# Architecture

OpenVerify MCP is a modular TypeScript service:

```
src/
  config/       Environment + defaults
  validators/   Syntax, DNS, disposable, role, SMTP, catch-all, orchestrator
  database/     SQLite + versioned migrations
  processing/   Batch + CSV jobs
  mcp/          MCP server factory + tools + STDIO
  http/         Express app, health, Streamable HTTP MCP
  security/     Auth, path, CSV, host guards
  types/        Shared Zod schemas
  utils/        Logger, concurrency
```

## Transports

- **STDIO** — local MCP clients (Cursor, Claude Desktop/Code, Gemini CLI). Logs → stderr only.
- **Streamable HTTP** — remote MCP via official SDK (`createMcpHandler` + Express). Endpoint default `/mcp`.

## Persistence

SQLite stores validation/domain caches, jobs, errors, settings. CSV inputs/outputs stay on the filesystem under configured directories.

## Extension

The validation orchestrator is transport-agnostic so a future Next.js dashboard can call the same engine without redesign.
