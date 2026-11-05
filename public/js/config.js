/**
 * MailSure frontend config.
 * Set API_BASE_URL to your self-hosted OpenVerify HTTP origin when the
 * website API is enabled (OPENVERIFY_WEBSITE_API_ENABLED=true).
 * Leave empty for GitHub Pages–only deploys — the UI will show a clear
 * "backend unavailable" message and will never invent results.
 */
window.MAILSURE_CONFIG = Object.freeze({
  /** e.g. "https://api.example.com" or "http://127.0.0.1:8787" — no trailing slash */
  API_BASE_URL: "",
  MAX_CSV_BYTES: 2 * 1024 * 1024,
  MAX_BATCH_EMAILS: 50,
  PRODUCT: "MailSure",
  TAGLINE: "Email Verification Made Simple.",
  PAGES_SITE: "https://eneelkant.github.io/email-validation-tool/",
  REPO: "https://github.com/eneelkant/email-validation-tool",
});
