# Security Policy — OpenVerify MCP

## Threat model (summary)

OpenVerify MCP validates email addresses using local syntax checks, DNS/MX lookups, a local disposable-domain dataset, optional SMTP diagnostics, and CSV processing. It is designed to run **self-hosted** without paid verification APIs.

### In scope risks

| Risk | Mitigation |
|------|------------|
| Path traversal via CSV tool paths | `assertSafeUserPath` with allowlisted roots |
| CSV formula injection in outputs | Leading `=@+-` cells prefixed with `'` |
| DNS rebinding against HTTP MCP | Host/origin validation via MCP Express helpers + `OPENVERIFY_ALLOWED_HOSTS` |
| Unauthenticated remote MCP | Fail-closed: `OPENVERIFY_HTTP_AUTH_TOKEN` **required** when HTTP binds to a non-loopback address (`0.0.0.0`, LAN/public IP). Optional only for `127.0.0.1` / `::1` / `localhost`. Startup aborts before listen if misconfigured. |
| Abuse / DoS | Request body limits, rate limiting, CSV size limits, concurrency caps |
| PII leakage in logs | Emails redacted from logs by default (`OPENVERIFY_LOG_EMAILS=false`) |
| SSRF via disposable update URL | HTTPS-only + hostname allowlist |
| Aggressive SMTP probing | Disabled by default; conservative timeouts; no mail sending |
| Secrets in repo | `.env` gitignored; `.env.example` has empty token placeholders |

### Out of scope / explicit non-goals

- Guaranteeing mailbox existence or deliverability
- Bypassing remote SMTP anti-abuse controls
- Storing prospect CSVs in third-party SaaS
- Automatic outbound telemetry

## Reporting a vulnerability

Please open a **private** security advisory on GitHub (preferred) or email the repository owner. Do not file a public issue for exploitable vulnerabilities.

Include:

1. Affected version / commit
2. Reproduction steps
3. Impact assessment

We aim to acknowledge reports within a reasonable timeframe and will coordinate disclosure.

## Supported versions

Security fixes target the latest `main` branch until numbered releases are published.

## HTTP authentication policy

| Bind host | Token |
|-----------|--------|
| `127.0.0.1`, `::1`, `localhost` | Optional (local development) |
| `0.0.0.0` or any non-loopback | **Mandatory** — process exits before binding if empty |

- Missing/incorrect Bearer on protected MCP routes → HTTP **401** (token value never echoed).
- Health endpoints (`/health`, `/ready`, `/version`) stay unauthenticated and must not expose secrets.
- Host-header validation remains enforced (DNS rebinding mitigation).

## Deployment recommendations

1. Prefer STDIO for local IDE clients; use loopback HTTP only for local experiments.
2. For remote HTTP: set a strong `OPENVERIFY_HTTP_AUTH_TOKEN`, restrict `OPENVERIFY_ALLOWED_HOSTS`, and terminate **HTTPS/TLS** at a reverse proxy.
3. Docker Compose binds `0.0.0.0` and therefore **requires** `OPENVERIFY_HTTP_AUTH_TOKEN` in `.env` (Compose interpolation fails closed if unset).
4. Do not bake certificates or tokens into the image.
5. Keep `OPENVERIFY_SMTP_ENABLED=false` unless you understand the operational and legal implications of SMTP probes.
6. Restrict filesystem mounts for Docker; only mount data volumes you trust.
7. Run `npm audit --omit=dev` in CI (already included).
8. Never log bearer tokens or full prospect email lists by default.
