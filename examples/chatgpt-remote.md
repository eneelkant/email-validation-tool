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

Or with Compose (token required because the container binds `0.0.0.0`):

```bash
echo 'OPENVERIFY_HTTP_AUTH_TOKEN=generate-a-long-random-token' >> .env
docker compose up --build
```

If `OPENVERIFY_HTTP_AUTH_TOKEN` is missing, the process **refuses to start** (fail-closed).

## 2. Expose HTTPS

Terminate TLS at a reverse proxy in front of port 8787. Forward `/mcp`, `/health`, `/ready`, `/version`.
Do not expose plain HTTP on the public internet.

## 3. ChatGPT configuration

In ChatGPT custom / MCP connector settings (wording varies by product surface):

- **URL:** `https://your.domain.example/mcp`
- **Auth:** Bearer token = value of `OPENVERIFY_HTTP_AUTH_TOKEN`
- **Transport:** Streamable HTTP (not legacy SSE-only unless your client requires it)

## Notes

- This guide has **not** been end-to-end verified inside the ChatGPT product UI in this repository’s automated suite — confirm against OpenAI’s current MCP docs for your account.
- Do not expose an unauthenticated MCP endpoint on the public internet.
- `valid_domain` results do **not** prove an individual mailbox exists.
