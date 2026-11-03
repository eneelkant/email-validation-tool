# Security Policy — OpenVerify MCP

## Threat model (summary)

OpenVerify MCP validates email addresses using local syntax checks, DNS/MX lookups, a local disposable-domain dataset, optional SMTP diagnostics, and CSV processing. It is designed to run **self-hosted** without paid verification APIs.

### In scope risks

| Risk | Mitigation |
|------|------------|
| Path traversal via CSV tool paths | `assertSafeUserPath` with allowlisted roots |
| CSV formula injection in outputs | Leading `=@+-` cells prefixed with `'` |
| DNS rebinding against HTTP MCP | Host/origin validation via MCP Express helpers + `OPENVERIFY_ALLOWED_HOSTS` |
| Unauthenticated remote MCP | Optional `OPENVERIFY_HTTP_AUTH_TOKEN` (Bearer); **required for non-localhost** |
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

## Deployment recommendations

1. Bind HTTP to localhost or a private network unless intentionally public.
2. Set a strong `OPENVERIFY_HTTP_AUTH_TOKEN` for any remote exposure.
3. Terminate TLS at a reverse proxy; do not bake certificates/secrets into the image.
4. Keep `OPENVERIFY_SMTP_ENABLED=false` unless you understand the operational and legal implications of SMTP probes.
5. Restrict filesystem mounts for Docker; only mount data volumes you trust.
6. Run `npm audit --omit=dev` in CI (already included).
