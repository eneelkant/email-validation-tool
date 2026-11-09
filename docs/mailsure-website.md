# MailSure website

**MailSure** — *Email Verification Made Simple.* — is the static public site for this repository, backed optionally by a verify-only HTTP API that reuses the MailSure MCP validation engine (`OPENVERIFY_*` env names kept for compatibility).

Live (after Pages is enabled and `deploy-pages.yml` succeeds on `main`):  
https://eneelkant.github.io/email-validation-tool/

## What ships

| Path | Purpose |
|------|---------|
| `public/` | Static HTML/CSS/JS for GitHub Pages |
| `src/http/website-api.ts` | Optional `/api/verify` + `/api/verify/batch` (not MCP) |
| `.github/workflows/deploy-pages.yml` | Deploys `public/` to GitHub Pages on `main` |

MCP tools, STDIO/HTTP MCP transport, validators, SQLite, Docker, and existing security controls are unchanged. The website API never exposes admin MCP tools (`clear_cache`, `update_disposable_domains`, job cancel, etc.).

## Pages settings (required once)

In the GitHub repository:

1. **Settings → Pages**
2. **Build and deployment → Source:** GitHub Actions
3. Merge to `main` (or run **Deploy MailSure Pages** via `workflow_dispatch` after merge)
4. Confirm the Actions run for `Deploy MailSure Pages` is green before treating the site as deployed

Site URL: `https://eneelkant.github.io/email-validation-tool/`  
Assets use **relative** paths so the project-pages base path works.

Until the workflow has succeeded on `main`, do not claim production Pages deployment.

## Frontend configuration — where to set the backend URL

Edit **`public/js/config.js`** → `API_BASE_URL`:

```js
API_BASE_URL: "https://email-validation-tool-8d370a7d.enzonic.dev" // no trailing slash
```

| Value | Behavior |
|-------|----------|
| `""` | Single **backend unavailable / not configured** banner; **never fabricates** ValidationResult data |
| `"http://127.0.0.1:8787"` | Local end-to-end against `npm run start:http` with website API enabled |
| `"https://…enzonic.dev"` / other self-hosted HTTPS origin | Production browser verify against that API |

- Current Pages production points at the Enzonic website API origin above (CORS: `https://eneelkant.github.io`). Enzonic hostnames are **deployment-specific** — update `API_BASE_URL` if the backend redeploys under a new hostname.
- Set `API_BASE_URL` only to an origin you operate with the website API enabled and CORS allowlisted.
- No secrets, bearer tokens, or fake API URLs in frontend source.
- After changing `config.js` for Pages, merge to `main` so the Pages workflow publishes it.

### Banner ownership (duplicate-warning fix)

The verify panel has two banners with distinct jobs:

| Element | Role |
|---------|------|
| `#backend-status` | Persistent connection state (not configured / unreachable / website API disabled / connected) |
| `#verify-feedback` | Form-only messages (empty input, CSV errors, HTTP/API errors after a live backend, bulk success) |

Connection warnings are shown **once** in `#backend-status`. Submit handlers do not repeat the same unavailable message in `#verify-feedback`.

## Website API (optional, self-hosted)

GitHub Pages cannot run Node. There is **no invented hosted API URL** in this repository. To power the verify UI you must run MailSure HTTP yourself (local, Docker Compose, VPS, or the Render Blueprint in [`render.yaml`](../render.yaml) — see [render-deploy.md](render-deploy.md)). Do **not** claim the backend is deployed until `GET /health` succeeds on a real origin you operate.

### Local development (practical)

Terminal A — API:

```bash
cp .env.example .env
# edit .env:
#   OPENVERIFY_TRANSPORT=http
#   OPENVERIFY_HTTP_HOST=127.0.0.1
#   OPENVERIFY_WEBSITE_API_ENABLED=true
#   OPENVERIFY_CORS_ORIGINS=http://127.0.0.1:3000
npm run build
npm run start:http
```

Terminal B — static site:

```bash
npx --yes serve public -l 3000
```

Point `public/js/config.js` at the API:

```js
API_BASE_URL: "http://127.0.0.1:8787"
```

Open `http://127.0.0.1:3000`, confirm the connected banner, then use Single / Bulk verify.

### Production deploy options (operator-hosted)

| Option | Notes |
|--------|--------|
| **Render Blueprint (`mailsure-api`)** | Root [`render.yaml`](../render.yaml). Docker, health `/health`, website API + Pages CORS, MCP token generated, **no persistent disk** (free tier; `/data` ephemeral). Operator steps: [render-deploy.md](render-deploy.md). Set `OPENVERIFY_ALLOWED_HOSTS` to the **real** Render hostname after create. Never invent the URL; leave `API_BASE_URL` empty until `/health` works. |
| **Enzonic Deploy** | Serverless package root is `/var/task` (read-only). Set `OPENVERIFY_EPHEMERAL_STORAGE=true` so runtime dirs remap to `os.tmpdir()` (never `mkdir` under `/var/task`). Prefer platform `PORT`; unset `OPENVERIFY_HTTP_HOST` (auto `0.0.0.0`) or set it explicitly. Requires `OPENVERIFY_HTTP_AUTH_TOKEN`, website API + CORS as below. See [troubleshooting.md](troubleshooting.md#enzonic--lambda-var-task-enoent). |
| **Docker Compose** | See `docker-compose.yml`. Requires `OPENVERIFY_HTTP_AUTH_TOKEN` (protects `/mcp`). Set `OPENVERIFY_WEBSITE_API_ENABLED=true`, `OPENVERIFY_CORS_ORIGINS=https://eneelkant.github.io`, and `OPENVERIFY_ALLOWED_HOSTS` to include your public API hostname. Terminate TLS at a reverse proxy. |
| **Bare Node on a VPS** | Same env as Compose; bind `0.0.0.0` only behind HTTPS reverse proxy with a strong MCP token. |
| **Other platform container** | Same image/`Dockerfile`; inject env vars; prefer platform `PORT`; persist `/data` for SQLite. |

SQLite paths default under `OPENVERIFY_DATA_DIR` / `OPENVERIFY_DB_PATH` (Compose uses the `openverify-data` volume).

Recommended production `.env` (values are examples — generate your own token):

```bash
OPENVERIFY_TRANSPORT=http
OPENVERIFY_HTTP_HOST=0.0.0.0
OPENVERIFY_HTTP_PORT=8787
OPENVERIFY_HTTP_AUTH_TOKEN=<generate-a-long-random-secret>
OPENVERIFY_ALLOWED_HOSTS=localhost,127.0.0.1,api.example.com
OPENVERIFY_WEBSITE_API_ENABLED=true
OPENVERIFY_CORS_ORIGINS=https://eneelkant.github.io
OPENVERIFY_WEBSITE_RATE_LIMIT_MAX=30
OPENVERIFY_WEBSITE_MAX_BATCH_SIZE=50
```

### Enzonic Deploy (website API + CORS)

Exact env vars for a verify-only API on Enzonic (read-only `/var/task` package):

```bash
OPENVERIFY_TRANSPORT=http
OPENVERIFY_EPHEMERAL_STORAGE=true
OPENVERIFY_WEBSITE_API_ENABLED=true
OPENVERIFY_CORS_ORIGINS=https://eneelkant.github.io
OPENVERIFY_HTTP_AUTH_TOKEN=<generate-a-long-random-secret>
OPENVERIFY_ALLOWED_HOSTS=localhost,127.0.0.1,<your-enzonic-api-host>
# Optional: OPENVERIFY_DB_PATH=:memory:
# Optional: OPENVERIFY_HTTP_HOST=0.0.0.0
# Platform PORT is used when set; if OPENVERIFY_HTTP_HOST is unset, bind is 0.0.0.0
```

Set `public/js/config.js` → `API_BASE_URL` only after `GET /health` succeeds on the real Enzonic HTTPS origin (no trailing slash). The current Pages config already points at `https://email-validation-tool-8d370a7d.enzonic.dev`; update that value if the backend redeploys under a new hostname. Never invent unrelated deploy URLs.

Then:

1. Deploy/start the process and confirm `GET https://api.example.com/health` returns `{ "status":"ok", "website_api": true }`.
2. Set `public/js/config.js` → `API_BASE_URL: "https://api.example.com"`.
3. Merge to `main` so Pages picks up the config.
4. From the live site, verify a known-invalid address (e.g. `not-an-email`) and confirm a real `ValidationResult` table row — never a mocked success.

Until step 1 succeeds from the public internet, **do not claim live Pages ↔ API E2E**.

### Endpoints (when enabled)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/health` | Liveness; includes `website_api` boolean |
| `POST` | `/api/verify` | Body `{ "email": string }` → `{ result: ValidationResult }` |
| `POST` | `/api/verify/batch` | Body `{ "emails": string[] }` (size-capped) → `{ results, count }` |

Frontend wiring: single form → `POST /api/verify`; bulk CSV → `POST /api/verify/batch`. Invalid/missing result shapes are rejected in the browser (no fabricated rows). CSV download + formula sanitization remain client-side.

### Safety notes

- Website API is **off by default** (`OPENVERIFY_WEBSITE_API_ENABLED=false`).
- Separate, stricter rate limits for `/api/*`.
- Batch size capped (`OPENVERIFY_WEBSITE_MAX_BATCH_SIZE`, max 100).
- JSON body limit remains 1mb on the Express app.
- CORS uses `OPENVERIFY_CORS_ORIGINS` allowlist as **full origins** (e.g. `https://eneelkant.github.io`). The HTTP app derives hostnames for the MCP Origin guard (which is hostname-only); do not put bare hostnames alone if you also need browser `Access-Control-Allow-Origin` reflection.
- MCP remains on `/mcp` with existing bearer auth rules; not aliased under `/api`.
- Non-loopback HTTP still requires `OPENVERIFY_HTTP_AUTH_TOKEN` for MCP startup fail-closed behavior. The website verify routes themselves do not require that bearer token; rely on CORS + rate limits + reverse-proxy controls.

### Blocker / limitation

Public verify-from-Pages requires a live MailSure HTTP origin with website API + CORS. The GitHub Pages site is wired to the current Enzonic hostname in `public/js/config.js`. If that deployment hostname changes, update `API_BASE_URL` and republish Pages. Website bulk CSV is **browser-side** parse + `POST /api/verify/batch` (not MCP `verify_csv` jobs).

## ValidationResult fields shown

The UI table mirrors `ValidationResult` in `src/types/results.ts`:

`email`, `normalized_email`, `syntax_valid`, `domain_exists`, `mx_exists`, `is_disposable`, `is_role_based`, `smtp_status`, `catch_all_status`, `overall_status`, `confidence`, `reason_codes`, `checked_at`

## Security & honesty

- No secrets in frontend source.
- HTML escaping for rendered results (XSS mitigation).
- Client CSV size/type checks; download path sanitizes formula-like cells (`=`, `@`, `+`, `-` prefixes).
- Copy states clearly: **no mailbox-existence claims**.
- Privacy/Terms pages are **drafts marked for legal review**.

## Manual checklist for operators

1. Copy `.env.example` → `.env`; never commit secrets.
2. Enable website API + CORS as above; keep MCP admin off the public `/api` surface.
3. `npm run build && npm run start:http` (or `docker compose up --build`).
4. `curl -s http://127.0.0.1:8787/health` → `website_api: true`.
5. Set `API_BASE_URL` in `public/js/config.js`.
6. Preview locally with `npx serve public`, then publish Pages via merge to `main`.
7. Confirm a real verify call from the browser; if the API is not deployed, leave `API_BASE_URL` empty.
