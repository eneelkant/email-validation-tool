# Deploy MailSure API on Render

**Product:** MailSure / MailSure MCP  
**Render service name:** `mailsure-api`  
**GitHub repo (unchanged):** [eneelkant/email-validation-tool](https://github.com/eneelkant/email-validation-tool)

This guide deploys the **verify-capable HTTP API + protected MCP** using the root [`render.yaml`](../render.yaml) Blueprint and the existing [`Dockerfile`](../Dockerfile). It does **not** claim a live backend URL — only you can confirm the HTTPS origin Render assigns after a successful deploy.

## What gets deployed

| Piece | Behavior |
|-------|----------|
| Web service `mailsure-api` | Docker runtime, branch `main`, health `GET /health` |
| HTTPS | Terminated by Render |
| Port | Render injects `PORT`; the app prefers `PORT` over `OPENVERIFY_HTTP_PORT` |
| Website API | `OPENVERIFY_WEBSITE_API_ENABLED=true` → `POST /api/verify`, `POST /api/verify/batch` |
| MCP | Still on `/mcp` with Bearer auth (admin tools stay MCP-only) |
| CORS | `https://eneelkant.github.io` for GitHub Pages |
| Disk | `/data` for SQLite + uploads/output (paid plans; free tier is ephemeral) |

Env var **names remain `OPENVERIFY_*`** so local `.env`, Compose, and docs stay compatible. Product identity is MailSure; do not rename those keys casually.

## Blueprint creation steps (operator)

1. Push/merge this repo’s `render.yaml` to the branch you link (Blueprint defaults to `main` for the service).
2. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**.
3. Connect the GitHub repo `eneelkant/email-validation-tool` and select the Blueprint file `render.yaml`.
4. When prompted for **`OPENVERIFY_ALLOWED_HOSTS`** (`sync: false`), enter:
   - Temporarily: `localhost,127.0.0.1` if you must create first, **then**
   - After Render shows the service hostname: `localhost,127.0.0.1,<your-service.onrender.com>` (plus any custom domain).
   - Health checks send that Host header — wrong hosts cause 403s.
5. Confirm **`OPENVERIFY_HTTP_AUTH_TOKEN`** is generated (`generateValue: true`). Copy it from the dashboard for MCP clients — never commit it.
6. Create the Blueprint and wait for the first deploy of `mailsure-api` to finish green.
7. Open the service’s public HTTPS URL (only the one Render shows you). Smoke-check:
   - `GET /health` → `status: ok`, `service: mailsure-api`, `website_api: true`
   - `GET /version` → `product: MailSure MCP`, `name: mailsure-mcp`
   - `POST /api/verify` with `{"email":"not-an-email"}` → real `ValidationResult` (invalid syntax)
   - `POST /mcp` without Bearer → **401** (admin surface protected)
8. Only after step 7 succeeds from the public internet:
   - Set `public/js/config.js` → `API_BASE_URL` to that **exact** origin (no trailing slash).
   - Merge to `main` so GitHub Pages publishes the config.
9. Until then, **leave `API_BASE_URL` empty**. Do not invent `*.onrender.com` URLs or claim the backend is deployed.

## Compatibility: `OPENVERIFY_*` env names

| Layer | Name |
|-------|------|
| Product / website / MCP serverInfo | **MailSure** / **MailSure MCP** (`mailsure-mcp`) |
| Render service | **mailsure-api** |
| Config env keys, Docker ENV, Compose | **`OPENVERIFY_*` (unchanged)** |
| SQLite path default | `/data/openverify.sqlite` (filename kept) |
| npm package / bin | `openverify-mcp` (import/CLI compatibility) |

Changing only the marketing/MCP display name avoids breaking existing operator `.env` files and MCP HTTP auth wiring.

## Security notes

- Non-loopback bind (`0.0.0.0`) **requires** `OPENVERIFY_HTTP_AUTH_TOKEN` (fail-closed at startup).
- Website verify routes do **not** use that bearer token; they rely on CORS allowlist + dedicated rate/batch limits.
- MCP admin tools (`clear_cache`, `update_disposable_domains`, job cancel, etc.) are **not** mounted under `/api`.
- No secrets belong in `public/js/config.js` or git.

## Local Render-like smoke (before Blueprint)

```bash
export PORT=10000
export OPENVERIFY_TRANSPORT=http
export OPENVERIFY_HTTP_HOST=0.0.0.0
export OPENVERIFY_HTTP_AUTH_TOKEN='local-dev-only-change-me'
export OPENVERIFY_ALLOWED_HOSTS=localhost,127.0.0.1
export OPENVERIFY_WEBSITE_API_ENABLED=true
export OPENVERIFY_CORS_ORIGINS=https://eneelkant.github.io
npm run build && npm run start:http
curl -s http://127.0.0.1:10000/health
```

## Related docs

- [MailSure website](mailsure-website.md)
- [MCP client setup](mcp-client-setup.md)
- [Security configuration](security-config.md)
