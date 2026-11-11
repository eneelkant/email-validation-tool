# Deploy MailSure API on Render

**Product:** MailSure / MailSure MCP  
**Render service name:** `mailsure-api`  
**GitHub repo (unchanged):** [eneelkant/email-validation-tool](https://github.com/eneelkant/email-validation-tool)  
**Plan target:** free-tier Web Service with **no persistent disk**

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
| Storage | **No `disk:` block** — SQLite/uploads/output under `/data` on the container filesystem (**ephemeral**; wiped on redeploy/restart) |

Env var **names remain `OPENVERIFY_*`** so local `.env`, Compose, and docs stay compatible. Product identity is MailSure; do not rename those keys casually.

## Free-tier / ephemeral data

- Blueprint intentionally omits Render persistent disks and paid managed databases (free tier compatible).
- `OPENVERIFY_EPHEMERAL_STORAGE=true` — `/health` reports `storage: "ephemeral"`; MCP CSV uploads under `/data/uploads` are deleted after the job finishes.
- Paths stay `OPENVERIFY_DATA_DIR=/data`, `OPENVERIFY_DB_PATH=/data/openverify.sqlite` (or set `:memory:` if you prefer no DB file). Dockerfile creates `/data` writable without a mounted disk.
- **Why SQLite is retained:** validation/domain caches (optional via TTL) and MCP CSV job tracking (`validation_jobs`) need an in-process store. Auth uses env Bearer tokens — **not** the DB. Website single/bulk verify does not require durable history (bulk CSV parse + result download are browser-side; API is JSON batch).
- Expect empty cache/jobs after every redeploy/restart. Fine for website verify; not for durable MCP job history.
- Optional: `OPENVERIFY_DB_PATH=:memory:` for pure process-lifetime SQLite (still wiped on restart).
- To persist later: add a Render disk on a paid plan and keep the same `/data` mount path (do not invent that until you upgrade).

## Blueprint creation / retry steps (operator)

1. Ensure this PR’s `render.yaml` (no `disk:`) is on the branch you link, or merge to `main` first if the Blueprint tracks `main`.
2. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint** (or open an existing Blueprint and **Manual Sync** / recreate if a prior attempt failed on disk).
3. Connect the GitHub repo `eneelkant/email-validation-tool` and select the Blueprint file `render.yaml`.
4. Choose a **free** Web Service plan if offered. Confirm the Blueprint does **not** attach a disk.
5. When prompted for **`OPENVERIFY_ALLOWED_HOSTS`** (`sync: false`), enter:
   - Temporarily: `localhost,127.0.0.1` if you must create first, **then**
   - After Render shows the service hostname: `localhost,127.0.0.1,<your-service.onrender.com>` (plus any custom domain).
   - Health checks send that Host header — wrong hosts cause 403s.
6. Confirm **`OPENVERIFY_HTTP_AUTH_TOKEN`** is generated (`generateValue: true`). Copy it from the dashboard for MCP clients — never commit it.
7. Create/sync the Blueprint and wait for the first deploy of `mailsure-api` to finish green.
8. Open the service’s public HTTPS URL (only the one Render shows you). Smoke-check:
   - `GET /health` → `status: ok`, `service: mailsure-api`, `website_api: true`, `storage: ephemeral`
   - `GET /version` → `product: MailSure MCP`, `name: mailsure-mcp`
   - `POST /api/verify` with `{"email":"not-an-email"}` → real `ValidationResult` (invalid syntax)
   - `POST /mcp` without Bearer → **401** (admin surface protected)
9. Only after step 8 succeeds from the public internet:
   - Set `public/js/config.js` → `API_BASE_URL` to that **exact** origin (no trailing slash).
   - Merge to `main` so GitHub Pages publishes the config.
10. Until then, **leave `API_BASE_URL` empty**. Do not invent `*.onrender.com` URLs or claim the backend is deployed.

### If a previous Blueprint failed because of a disk

1. Delete the failed Blueprint/service **or** edit/sync after this no-disk `render.yaml` is on the linked branch.
2. Re-run Blueprint create/sync — there should be no disk attachment prompt for free tier.
3. Re-enter `OPENVERIFY_ALLOWED_HOSTS` if prompted; token may regenerate — update any MCP clients.

## Compatibility: `OPENVERIFY_*` env names

| Layer | Name |
|-------|------|
| Product / website / MCP serverInfo | **MailSure** / **MailSure MCP** (`mailsure-mcp`) |
| Render service | **mailsure-api** |
| Config env keys, Docker ENV, Compose | **`OPENVERIFY_*` (unchanged)** |
| SQLite path on Render (ephemeral) | `/data/openverify.sqlite` (filename kept) |
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

## Optional Reacher SMTP (separate service)

MailSure can call a **separate** Reacher deploy for SMTP diagnostics without merging that repo:

| Env | Notes |
|-----|--------|
| `REACHER_ENABLED` | Default `false` (unchanged behavior) |
| `REACHER_API_URL` | Origin only, e.g. `https://reacher-render-deploy.onrender.com` |
| `REACHER_TIMEOUT` | Milliseconds (default `15000`) |

Set these in the MailSure Render dashboard after your Reacher web service is up. Reacher stays in `eneelkant/reacher-render-deploy`. Prefer leaving Reacher off on free-tier until cold-start latency is acceptable. See [validation-limitations.md](validation-limitations.md).

## Related docs

- [MailSure website](mailsure-website.md)
- [MCP client setup](mcp-client-setup.md)
- [Security configuration](security-config.md)
