# ChatGPT custom MCP (remote Streamable HTTP)

OpenVerify MCP can be connected as a **remote** MCP server when you run the HTTP transport behind HTTPS (TLS termination at a reverse proxy is fine).

## 1. Run the server

```bash
export OPENVERIFY_TRANSPORT=http
export OPENVERIFY_HTTP_HOST=0.0.0.0
export OPENVERIFY_HTTP_PORT=8787
export OPENVERIFY_HTTP_AUTH_TOKEN='generate-a-long-random-token'
export OPENVERIFY_ALLOWED_HOSTS='your.domain.example'
npm run build && node dist/index.js --transport http
```

Or: `docker compose up`.

## 2. Expose HTTPS

Terminate TLS in front of port 8787. Forward `/mcp`, `/health`, `/ready`, `/version`.

## 3. ChatGPT configuration

In ChatGPT custom / MCP connector settings (wording varies by product surface):

- **URL:** `https://your.domain.example/mcp`
- **Auth:** Bearer token = value of `OPENVERIFY_HTTP_AUTH_TOKEN`
- **Transport:** Streamable HTTP (not legacy SSE-only unless your client requires it)

## Notes

- Compatibility depends on ChatGPT’s current MCP client support — verify against OpenAI’s latest docs before claiming production use.
- Do not expose an unauthenticated MCP endpoint on the public internet.
- `valid_domain` results do **not** prove an individual mailbox exists.
