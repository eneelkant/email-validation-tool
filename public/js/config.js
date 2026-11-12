/**
 * MailSure frontend config.
 *
 * WHERE TO SET THE BACKEND URL
 * ----------------------------
 * Edit API_BASE_URL below to your self-hosted MailSure HTTP origin (mailsure-api)
 * when the website API is enabled (OPENVERIFY_WEBSITE_API_ENABLED=true).
 *
 * Examples:
 *   Local loopback:  "http://127.0.0.1:8787"
 *   Deployed API:    "https://api.example.com"  // only a real origin you operate
 *
 * Set only after GET /health succeeds on an origin you operate (website API + CORS).
 * Production Pages must use the stable Enzonic origin
 * https://email-validation-tool.enzonic.dev — not ephemeral deploy ids such as
 * *-8d370a7d or *-8121831f. Leave empty only when no API is live; the UI then
 * shows a single clear "backend unavailable" banner and never invents results.
 *
 * Do not put secrets, bearer tokens, or fabricated API URLs here.
 * After changing this file for Pages, merge to main so deploy-pages.yml publishes it.
 */
window.MAILSURE_CONFIG = Object.freeze({
  /** e.g. "https://api.example.com" or "http://127.0.0.1:8787" — no trailing slash */
  API_BASE_URL: "https://email-validation-tool.enzonic.dev",
  MAX_CSV_BYTES: 2 * 1024 * 1024,
  MAX_BATCH_EMAILS: 50,
  PRODUCT: "MailSure",
  TAGLINE: "Email Verification Made Simple.",
  PAGES_SITE: "https://eneelkant.github.io/email-validation-tool/",
  REPO: "https://github.com/eneelkant/email-validation-tool",
});
