# MailSure website

**MailSure** — *Email Verification Made Simple.* — is the static public site for this repository, backed optionally by a verify-only HTTP API that reuses the OpenVerify validation engine.

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
3. Merge this branch to `main` (or run **Deploy MailSure Pages** via `workflow_dispatch` after merge)
4. Confirm the Actions run for `Deploy MailSure Pages` is green before treating the site as deployed

Site URL: `https://eneelkant.github.io/email-validation-tool/`  
Assets use **relative** paths so the project-pages base path works.

Until the workflow has succeeded on `main`, do not claim production Pages deployment.

## Frontend configuration

Edit `public/js/config.js`:

```js
API_BASE_URL: "" // e.g. "https://your-api.example.com" or "http://127.0.0.1:8787"
```

- Empty `API_BASE_URL` (default for Pages): UI shows a clear **backend unavailable / not configured** message and **never fabricates** ValidationResult data.
- Set `API_BASE_URL` only to an origin you operate with the website API enabled and CORS allowlisted.

## Website API (optional, self-hosted)

GitHub Pages cannot run Node. To power the verify UI:

```bash
# .env (never commit secrets)
OPENVERIFY_TRANSPORT=http
OPENVERIFY_HTTP_HOST=127.0.0.1   # or 0.0.0.0 with OPENVERIFY_HTTP_AUTH_TOKEN set for MCP
OPENVERIFY_WEBSITE_API_ENABLED=true
OPENVERIFY_CORS_ORIGINS=https://eneelkant.github.io
OPENVERIFY_WEBSITE_RATE_LIMIT_MAX=30
OPENVERIFY_WEBSITE_MAX_BATCH_SIZE=50
```

Endpoints (when enabled):

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/health` | Existing liveness; includes `website_api` boolean |
| `POST` | `/api/verify` | Body `{ "email": string }` → `{ result: ValidationResult }` |
| `POST` | `/api/verify/batch` | Body `{ "emails": string[] }` (size-capped) → `{ results, count }` |

### Safety notes

- Website API is **off by default** (`OPENVERIFY_WEBSITE_API_ENABLED=false`).
- Separate, stricter rate limits for `/api/*`.
- Batch size capped (`OPENVERIFY_WEBSITE_MAX_BATCH_SIZE`, max 100).
- JSON body limit remains 1mb on the Express app.
- CORS uses `OPENVERIFY_CORS_ORIGINS` allowlist (set your Pages origin for browser calls).
- MCP remains on `/mcp` with existing bearer auth rules; not aliased under `/api`.
- Non-loopback HTTP still requires `OPENVERIFY_HTTP_AUTH_TOKEN` for MCP startup fail-closed behavior.

### Blocker / limitation

There is **no** hosted MailSure cloud API in this repository. Public verify-from-Pages requires you (or an operator) to run OpenVerify HTTP somewhere with the website API + CORS configured. Until then, use MCP locally; the static site remains a documentation and UX surface without fake results.

## ValidationResult fields shown

The UI table mirrors `ValidationResult` in `src/types/results.ts`:

`email`, `normalized_email`, `syntax_valid`, `domain_exists`, `mx_exists`, `is_disposable`, `is_role_based`, `smtp_status`, `catch_all_status`, `overall_status`, `confidence`, `reason_codes`, `checked_at`

## Security & honesty

- No secrets in frontend source.
- HTML escaping for rendered results (XSS mitigation).
- Client CSV size/type checks; download path sanitizes formula-like cells (`=`, `@`, `+`, `-` prefixes).
- Copy states clearly: **no mailbox-existence claims**.
- Privacy/Terms pages are **drafts marked for legal review**.

## Local preview of static files

```bash
# any static server from public/
npx --yes serve public
```

For end-to-end verify against a local API:

```bash
OPENVERIFY_TRANSPORT=http \
OPENVERIFY_WEBSITE_API_ENABLED=true \
OPENVERIFY_CORS_ORIGINS=http://127.0.0.1:3000 \
npm run start:http
# point public/js/config.js API_BASE_URL at http://127.0.0.1:8787
```
