# Contributing to MailSure MCP

Thanks for helping improve this project.

## Development setup

Requirements: **Node.js 22+**

```bash
git clone https://github.com/eneelkant/email-validation-tool.git
cd email-validation-tool
npm install
cp .env.example .env
npm test
npm run build
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run typecheck` | Strict TypeScript check |
| `npm test` | Vitest suite |
| `npm run build` | Compile `src/` → `dist/` |
| `npm run start:stdio` | Run MCP over STDIO |
| `npm run start:http` | Run Streamable HTTP MCP |
| `npm run update:disposable` | Opt-in multi-source disposable sync (fail-safe replace; strips allowlist + free providers). `--url` for single-source; `--dry-run` to validate without writing |
| `.github/workflows/update-disposable-domains.yml` | Daily + manual Action that runs the sync and opens an automation PR (never pushes `main`, never auto-merges) |

## Guidelines

- Prefer small, focused PRs.
- Do not commit secrets, prospect CSVs, or real email lists.
- Do not claim mailbox deliverability from DNS/MX alone.
- Keep SMTP diagnostics off by default.
- Add tests for new validation behavior.
- Match existing TypeScript style (strict, ESM, Zod schemas).

## Pull requests

Use the PR template. Ensure CI is green (`typecheck`, `test`, Docker build).
