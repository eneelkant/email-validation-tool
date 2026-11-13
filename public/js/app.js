/**
 * MailSure page interactions: nav, tabs, single + bulk verify.
 *
 * Banner ownership (avoids duplicate warnings):
 * - #backend-status — persistent connection state (not configured / unreachable / disabled / connected)
 * - #verify-feedback — form-only messages (empty input, CSV errors, API errors after a live backend,
 *   bulk success). Never repeats the same connection warning already shown in #backend-status.
 */
(function () {
  "use strict";

  /** @type {{ kind: string, message?: string }} */
  let backendState = { kind: "unknown" };

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

  /**
   * Push a GTM dataLayer event without PII (emails, CSV contents, filenames).
   * Safe no-op when analytics.js is absent.
   */
  function track(eventName, params) {
    const analytics = window.MailSureAnalytics;
    if (!analytics || typeof analytics.pushEvent !== "function") return;
    analytics.pushEvent(eventName, params || {});
  }

  function setBackendStatus(kind, type, message) {
    backendState = { kind: kind, message: message };
    showBanner($("#backend-status"), type, message);
  }

  function emphasizeBackendStatus() {
    const status = $("#backend-status");
    if (!status || status.hidden) return;
    if (typeof status.scrollIntoView === "function") {
      status.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  /**
   * Connection problems are owned by #backend-status.
   * Returns true when the caller should stop (do not also write #verify-feedback).
   */
  function handleConnectionIssue(reason, feedbackEl) {
    const msg = window.MailSureApi.unavailableMessage(reason);
    const type = reason === "not_configured" || reason === "website_api_disabled" ? "warn" : "error";
    setBackendStatus(reason, type, msg);
    hideBanner(feedbackEl);
    emphasizeBackendStatus();
    return true;
  }

  async function initBackendBanner() {
    const banner = $("#backend-status");
    if (!banner || !window.MailSureApi) return;

    if (!window.MailSureApi.isConfigured()) {
      setBackendStatus(
        "not_configured",
        "warn",
        window.MailSureApi.unavailableMessage("not_configured"),
      );
      return;
    }

    const health = await window.MailSureApi.checkHealth();
    if (!health.ok) {
      setBackendStatus(
        health.reason || "unreachable",
        "error",
        window.MailSureApi.unavailableMessage(health.reason || "unreachable"),
      );
      return;
    }

    if (health.body && health.body.website_api === false) {
      setBackendStatus(
        "website_api_disabled",
        "warn",
        "API is reachable but the MailSure website API is disabled on the server " +
          "(OPENVERIFY_WEBSITE_API_ENABLED=false). Enable it to verify from this page.",
      );
      return;
    }

    setBackendStatus(
      "ok",
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
        handleConnectionIssue("not_configured", banner);
        window.MailSureApi.renderResults(results, []);
        return;
      }
      submit.disabled = true;
      try {
        const health = await window.MailSureApi.checkHealth();
        if (!health.ok) {
          handleConnectionIssue(health.reason || "unreachable", banner);
          window.MailSureApi.renderResults(results, []);
          return;
        }
        if (health.body && health.body.website_api === false) {
          handleConnectionIssue("website_api_disabled", banner);
          window.MailSureApi.renderResults(results, []);
          return;
        }
        track("email_verification_started", { verification_mode: "single" });
        const result = await window.MailSureApi.verifyEmail(email);
        lastResults = [result];
        window.MailSureApi.renderResults(results, lastResults);
        if (downloadBtn) downloadBtn.hidden = false;
        hideBanner(banner);
        track("email_verification_completed", {
          verification_mode: "single",
          overall_status: result && result.overall_status ? String(result.overall_status) : "unknown",
          confidence: result && result.confidence ? String(result.confidence) : "unknown",
        });
      } catch (err) {
        lastResults = [];
        window.MailSureApi.renderResults(results, []);
        if (downloadBtn) downloadBtn.hidden = true;
        const code = err && err.code;
        if (code && window.MailSureApi.isConnectionReason(code)) {
          handleConnectionIssue(code, banner);
        } else {
          showBanner(banner, "error", err.message || "Verification failed.");
        }
      } finally {
        submit.disabled = false;
      }
    });

    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => {
        if (!lastResults.length) return;
        const csv = window.MailSureCsv.resultsToCsv(lastResults);
        window.MailSureCsv.downloadText("mailsure-results.csv", csv);
        track("csv_downloaded", { download_kind: "results", result_count: lastResults.length });
      });
    }

    // Expose setter for bulk path reuse of download button
    form._setLastResults = (rows) => {
      lastResults = rows;
      if (downloadBtn) downloadBtn.hidden = !rows.length;
    };
  }

  function setCsvFilename(file) {
    const label = $("#csv-filename");
    if (!label) return;
    if (file && file.name) {
      label.textContent = file.name;
      label.classList.add("has-file");
    } else {
      label.textContent = "No file selected";
      label.classList.remove("has-file");
    }
  }

  function setCsvFileError(message) {
    const el = $("#csv-file-error");
    if (!el) return;
    if (message) {
      el.hidden = false;
      el.textContent = message;
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }

  function assignCsvFile(fileInput, file) {
    if (!fileInput || !file) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    } catch (_err) {
      // Some browsers disallow programmatic FileList assignment; change event still covers picker.
    }
    setCsvFilename(file);
    try {
      window.MailSureCsv.assertCsvFile(file);
      setCsvFileError("");
      // Filename omitted intentionally — may contain PII.
      track("bulk_csv_uploaded", {
        verification_mode: "bulk",
        file_extension: "csv",
        file_size_bytes: typeof file.size === "number" ? file.size : 0,
      });
    } catch (err) {
      setCsvFileError(err.message || "Unsupported file type. Please upload a .csv file.");
    }
  }

  function initBulkVerify() {
    const form = $("#bulk-verify-form");
    const results = $("#results");
    const banner = $("#verify-feedback");
    const downloadBtn = $("#download-csv");
    const sampleBtn = $("#download-sample-csv");
    const dropzone = $("#csv-dropzone");
    const fileInput = $("#csv-input");
    const submit = $("#bulk-submit") || (form && form.querySelector('button[type="submit"]'));
    const singleForm = $("#single-verify-form");
    if (!form) return;

    if (sampleBtn) {
      sampleBtn.addEventListener("click", () => {
        window.MailSureCsv.downloadSampleCsv();
        track("csv_downloaded", { download_kind: "sample" });
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        setCsvFilename(file || null);
        if (!file) {
          setCsvFileError("");
          return;
        }
        try {
          window.MailSureCsv.assertCsvFile(file);
          setCsvFileError("");
          // Filename omitted intentionally — may contain PII.
          track("bulk_csv_uploaded", {
            verification_mode: "bulk",
            file_extension: "csv",
            file_size_bytes: typeof file.size === "number" ? file.size : 0,
          });
        } catch (err) {
          setCsvFileError(err.message || "Unsupported file type. Please upload a .csv file.");
        }
      });
    }

    if (dropzone && fileInput) {
      ["dragenter", "dragover"].forEach((type) => {
        dropzone.addEventListener(type, (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dropzone.classList.add("is-dragover");
        });
      });
      ["dragleave", "drop"].forEach((type) => {
        dropzone.addEventListener(type, (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dropzone.classList.remove("is-dragover");
        });
      });
      dropzone.addEventListener("drop", (ev) => {
        const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (!file) return;
        assignCsvFile(fileInput, file);
      });
    }

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      hideBanner(banner);
      setCsvFileError("");
      const file = fileInput && fileInput.files ? fileInput.files[0] : null;
      const cfg = window.MAILSURE_CONFIG || {};

      if (!window.MailSureApi.isConfigured()) {
        handleConnectionIssue("not_configured", banner);
        window.MailSureApi.renderResults(results, []);
        return;
      }

      try {
        window.MailSureCsv.assertCsvFile(file);
      } catch (err) {
        setCsvFileError(err.message || "Unsupported file type. Please upload a .csv file.");
        showBanner(banner, "error", err.message || "Please upload a .csv file.");
        return;
      }

      if (submit) submit.disabled = true;
      if (sampleBtn) sampleBtn.disabled = true;
      const previousLabel = submit ? submit.textContent : "";
      if (submit) submit.textContent = "Verifying…";

      try {
        const { emails } = await window.MailSureCsv.extractEmailsFromCsvFile(file, {
          maxBytes: cfg.MAX_CSV_BYTES || 2 * 1024 * 1024,
          maxEmails: cfg.MAX_BATCH_EMAILS || 50,
        });
        const health = await window.MailSureApi.checkHealth();
        if (!health.ok) {
          handleConnectionIssue(health.reason || "unreachable", banner);
          window.MailSureApi.renderResults(results, []);
          return;
        }
        if (health.body && health.body.website_api === false) {
          handleConnectionIssue("website_api_disabled", banner);
          window.MailSureApi.renderResults(results, []);
          return;
        }
        track("email_verification_started", {
          verification_mode: "bulk",
          email_count: emails.length,
        });
        const batch = await window.MailSureApi.verifyBatch(emails);
        window.MailSureApi.renderResults(results, batch);
        if (singleForm && singleForm._setLastResults) singleForm._setLastResults(batch);
        if (downloadBtn) downloadBtn.hidden = false;
        showBanner(
          banner,
          "info",
          "Verified " + batch.length + " unique email(s) from CSV. Formula-like cells are sanitized on download.",
        );
        track("bulk_verification_completed", {
          verification_mode: "bulk",
          result_count: batch.length,
        });
      } catch (err) {
        window.MailSureApi.renderResults(results, []);
        if (downloadBtn) downloadBtn.hidden = true;
        const code = err && err.code;
        if (code && window.MailSureApi.isConnectionReason(code)) {
          handleConnectionIssue(code, banner);
        } else {
          const message = err.message || "Bulk verification failed.";
          if (/csv|file|header|email column|unsupported/i.test(message)) {
            setCsvFileError(message);
          }
          showBanner(banner, "error", message);
        }
      } finally {
        if (submit) {
          submit.disabled = false;
          submit.textContent = previousLabel || "Verify CSV";
        }
        if (sampleBtn) sampleBtn.disabled = false;
      }
    });
  }

  // Test hook: expose backend state without polluting production UX.
  window.__mailsureBackendState = function () {
    return backendState;
  };

  document.addEventListener("DOMContentLoaded", () => {
    initNav();
    initTabs();
    initBackendBanner();
    initSingleVerify();
    initBulkVerify();
  });
})();
