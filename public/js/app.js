/**
 * MailSure page interactions: nav, tabs, single + bulk verify.
 */
(function () {
  "use strict";

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function initNav() {
    const toggle = $(".nav-toggle");
    const links = $(".nav-links");
    if (!toggle || !links) return;
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function initTabs() {
    const tabs = document.querySelectorAll('[role="tab"]');
    const panels = document.querySelectorAll('[role="tabpanel"]');
    if (!tabs.length) return;

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("aria-controls");
        tabs.forEach((t) => t.setAttribute("aria-selected", t === tab ? "true" : "false"));
        panels.forEach((p) => {
          p.hidden = p.id !== target;
        });
      });
    });
  }

  function showBanner(el, type, message) {
    if (!el) return;
    el.hidden = false;
    el.className = "banner banner-" + type;
    el.textContent = message;
  }

  function hideBanner(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  async function initBackendBanner() {
    const banner = $("#backend-status");
    if (!banner || !window.MailSureApi) return;

    if (!window.MailSureApi.isConfigured()) {
      showBanner(banner, "warn", window.MailSureApi.unavailableMessage("not_configured"));
      return;
    }

    const health = await window.MailSureApi.checkHealth();
    if (!health.ok) {
      showBanner(banner, "error", window.MailSureApi.unavailableMessage(health.reason));
      return;
    }

    if (health.body && health.body.website_api === false) {
      showBanner(
        banner,
        "warn",
        "API is reachable but the MailSure website API is disabled on the server " +
          "(OPENVERIFY_WEBSITE_API_ENABLED=false). Enable it to verify from this page.",
      );
      return;
    }

    showBanner(
      banner,
      "info",
      "Connected to verification backend. Domain-level checks only — not mailbox existence proof.",
    );
  }

  function initSingleVerify() {
    const form = $("#single-verify-form");
    const results = $("#results");
    const banner = $("#verify-feedback");
    const downloadBtn = $("#download-csv");
    if (!form) return;

    let lastResults = [];

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      hideBanner(banner);
      const input = $("#email-input");
      const submit = form.querySelector('button[type="submit"]');
      const email = (input && input.value ? input.value : "").trim();
      if (!email) {
        showBanner(banner, "error", "Enter an email address.");
        return;
      }
      if (!window.MailSureApi.isConfigured()) {
        showBanner(banner, "warn", window.MailSureApi.unavailableMessage("not_configured"));
        window.MailSureApi.renderResults(results, []);
        return;
      }
      submit.disabled = true;
      try {
        const health = await window.MailSureApi.checkHealth();
        if (!health.ok) {
          showBanner(banner, "error", window.MailSureApi.unavailableMessage(health.reason));
          window.MailSureApi.renderResults(results, []);
          return;
        }
        const result = await window.MailSureApi.verifyEmail(email);
        lastResults = [result];
        window.MailSureApi.renderResults(results, lastResults);
        if (downloadBtn) downloadBtn.hidden = false;
        hideBanner(banner);
      } catch (err) {
        lastResults = [];
        window.MailSureApi.renderResults(results, []);
        if (downloadBtn) downloadBtn.hidden = true;
        showBanner(banner, "error", err.message || "Verification failed.");
      } finally {
        submit.disabled = false;
      }
    });

    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => {
        if (!lastResults.length) return;
        const csv = window.MailSureCsv.resultsToCsv(lastResults);
        window.MailSureCsv.downloadText("mailsure-results.csv", csv);
      });
    }

    // Expose setter for bulk path reuse of download button
    form._setLastResults = (rows) => {
      lastResults = rows;
      if (downloadBtn) downloadBtn.hidden = !rows.length;
    };
  }

  function initBulkVerify() {
    const form = $("#bulk-verify-form");
    const results = $("#results");
    const banner = $("#verify-feedback");
    const downloadBtn = $("#download-csv");
    const singleForm = $("#single-verify-form");
    if (!form) return;

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      hideBanner(banner);
      const fileInput = $("#csv-input");
      const submit = form.querySelector('button[type="submit"]');
      const file = fileInput && fileInput.files ? fileInput.files[0] : null;
      const cfg = window.MAILSURE_CONFIG || {};

      if (!window.MailSureApi.isConfigured()) {
        showBanner(banner, "warn", window.MailSureApi.unavailableMessage("not_configured"));
        window.MailSureApi.renderResults(results, []);
        return;
      }

      submit.disabled = true;
      try {
        const { emails } = await window.MailSureCsv.extractEmailsFromCsvFile(file, {
          maxBytes: cfg.MAX_CSV_BYTES || 2 * 1024 * 1024,
          maxEmails: cfg.MAX_BATCH_EMAILS || 50,
        });
        const health = await window.MailSureApi.checkHealth();
        if (!health.ok) {
          showBanner(banner, "error", window.MailSureApi.unavailableMessage(health.reason));
          window.MailSureApi.renderResults(results, []);
          return;
        }
        const batch = await window.MailSureApi.verifyBatch(emails);
        window.MailSureApi.renderResults(results, batch);
        if (singleForm && singleForm._setLastResults) singleForm._setLastResults(batch);
        if (downloadBtn) downloadBtn.hidden = false;
        showBanner(
          banner,
          "info",
          "Verified " + batch.length + " unique email(s) from CSV. Formula-like cells are sanitized on download.",
        );
      } catch (err) {
        window.MailSureApi.renderResults(results, []);
        if (downloadBtn) downloadBtn.hidden = true;
        showBanner(banner, "error", err.message || "Bulk verification failed.");
      } finally {
        submit.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initNav();
    initTabs();
    initBackendBanner();
    initSingleVerify();
    initBulkVerify();
  });
})();
