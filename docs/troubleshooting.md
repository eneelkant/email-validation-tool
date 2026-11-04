# Troubleshooting — OpenVerify MCP

## Process will not start (HTTP)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Exits immediately mentioning `OPENVERIFY_HTTP_AUTH_TOKEN` | Non-loopback bind without token | Set a strong token, or bind `127.0.0.1` for local-only |
| Compose fails on interpolation | Token unset in `.env` | `echo 'OPENVERIFY_HTTP_AUTH_TOKEN=…' >> .env` |
| Port in use | Another process on `OPENVERIFY_HTTP_PORT` | Change port or stop the other listener |

## MCP client cannot connect (STDIO)

1. Confirm `npm run build` produced `dist/index.js`.
2. Use an **absolute** path in Claude Desktop configs.
3. Ensure the client’s cwd can resolve relative `dist/…` (Cursor/Gemini).
4. Check client logs for stderr from OpenVerify (`OPENVERIFY_LOG_LEVEL=debug`).
5. Never write banners to stdout in wrappers — stdout is the MCP wire.

## HTTP 401 / 403

- **401** — missing or wrong Bearer token on `/mcp`.
- **403 Invalid Host** — `Host` header not in `OPENVERIFY_ALLOWED_HOSTS`. `X-Forwarded-Host` alone will not whitelist an evil Host.

## Validation surprises

| Observation | Explanation |
|-------------|-------------|
| `valid_domain` but mail bounces later | Domain/MX OK ≠ mailbox proof (SMTP off by default) |
| `temporary_error` | DNS/SMTP transient failure — retry; do not mark invalid |
| `disposable` false for a known throwaway | Local list stale — run `update_disposable_domains` / `npm run update:disposable` |
| SMTP always `not_checked` | Expected unless `OPENVERIFY_SMTP_ENABLED=true` |

## CSV jobs

| Symptom | Fix |
|---------|-----|
| `Email column "…" not found` | Only when preferred `email_column` is set; pass a real header or omit it (auto-detect / first-column fallback) |
| Wrong column validated | Nonstandard headers without `email_column` fall back to the **first** column — set `email_column` explicitly |
| Job `failed` on huge file | Check `OPENVERIFY_MAX_CSV_BYTES` |
| Job stuck `running` | Check disk for output path; cancel via `cancel_validation_job` |
| Path rejected | Stay under upload/output **or** `OPENVERIFY_DATA_DIR` / process CWD allowlists (see [security-config.md](./security-config.md#csv-path-allowlists)) |

## Docker (when available)

```bash
# Required token
echo 'OPENVERIFY_HTTP_AUTH_TOKEN=change-me-to-a-long-random-value' >> .env
docker compose up --build
curl -sS http://127.0.0.1:8787/health
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'   # expect 401 without Authorization
docker compose down
```

## Useful commands

```bash
npm run typecheck && npm test && npm run build
node dist/index.js --transport stdio
node dist/index.js --transport http
npm audit --omit=dev
```
