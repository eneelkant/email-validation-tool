/**
 * MailSure API client + result rendering.
 * Never fabricates ValidationResult data when the backend is unavailable.
 */
(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function apiBase() {
    const cfg = global.MAILSURE_CONFIG || {};
    return String(cfg.API_BASE_URL || "").replace(/\/$/, "");
  }

  function isConfigured() {
    return apiBase().length > 0;
  }

  /**
   * Required ValidationResult fields from MailSure MCP (see src/types/results.ts).
   * Reject incomplete/malformed payloads instead of rendering fake success.
   */
  function assertValidationResult(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(
        new Error("Invalid " + label + ": backend did not return a ValidationResult object."),
        { code: "invalid_response" },
      );
    }
    const required = [
      "email",
      "normalized_email",
      "syntax_valid",
      "is_disposable",
      "is_free_provider",
      "provider_type",
      "smtp_status",
      "catch_all_status",
      "overall_status",
      "confidence",
      "reason_codes",
      "checked_at",
    ];
    for (const key of required) {
      if (!(key in value)) {
        throw Object.assign(
          new Error("Invalid " + label + ": missing field '" + key + "'."),
          { code: "invalid_response" },
        );
      }
    }
    if (!Array.isArray(value.reason_codes)) {
      throw Object.assign(
        new Error("Invalid " + label + ": reason_codes must be an array."),
        { code: "invalid_response" },
      );
    }
    if (typeof value.syntax_valid !== "boolean") {
      throw Object.assign(
        new Error("Invalid " + label + ": syntax_valid must be a boolean."),
        { code: "invalid_response" },
      );
    }
    return value;
  }

  async function parseJsonResponse(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_err) {
      throw Object.assign(
        new Error("Backend returned non-JSON (HTTP " + res.status + ")."),
        { code: "invalid_response", status: res.status },
      );
    }
  }

  async function checkHealth() {
    if (!isConfigured()) {
      return { ok: false, reason: "not_configured" };
    }
    try {
      const res = await fetch(apiBase() + "/health", {
        method: "GET",
        mode: "cors",
        credentials: "omit",
      });
      if (!res.ok) {
        return { ok: false, reason: "unhealthy", status: res.status };
      }
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return { ok: false, reason: "invalid_health" };
      }
      return { ok: true, body };
    } catch (_err) {
      return { ok: false, reason: "unreachable" };
    }
  }

  async function verifyEmail(email) {
    if (!isConfigured()) {
      throw Object.assign(new Error("Backend API URL is not configured."), {
        code: "not_configured",
      });
    }
    let res;
    try {
      res = await fetch(apiBase() + "/api/verify", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch (_err) {
      throw Object.assign(new Error("Verification backend is unreachable."), {
        code: "unreachable",
      });
    }
    const body = await parseJsonResponse(res);
    if (!res.ok) {
      throw Object.assign(new Error(body.detail || body.error || "Verification failed"), {
        code: body.error || "http_error",
        status: res.status,
      });
    }
    return assertValidationResult(body.result, "verify response");
  }

  async function verifyBatch(emails) {
    if (!isConfigured()) {
      throw Object.assign(new Error("Backend API URL is not configured."), {
        code: "not_configured",
      });
    }
    let res;
    try {
      res = await fetch(apiBase() + "/api/verify/batch", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ emails }),
      });
    } catch (_err) {
      throw Object.assign(new Error("Verification backend is unreachable."), {
        code: "unreachable",
      });
    }
    const body = await parseJsonResponse(res);
    if (!res.ok) {
      throw Object.assign(new Error(body.detail || body.error || "Batch verification failed"), {
        code: body.error || "http_error",
        status: res.status,
      });
    }
    if (!Array.isArray(body.results)) {
      throw Object.assign(
        new Error("Invalid batch response: expected results array."),
        { code: "invalid_response" },
      );
    }
    return body.results.map(function (row, i) {
      return assertValidationResult(row, "batch result[" + i + "]");
    });
  }

  function formatNullable(v) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  }

  /** Human labels for provider_type (matches server classifyProvider). */
  function providerTypeLabel(providerType) {
    if (providerType === "disposable") return "Disposable email address";
    if (providerType === "free") return "Free email provider";
    return null;
  }

  function renderProviderLabel(r) {
    const label = providerTypeLabel(r.provider_type);
    if (!label) return "—";
    const cls =
      r.provider_type === "disposable"
        ? "provider-label provider-disposable"
        : "provider-label provider-free";
    return '<span class="' + cls + '">' + escapeHtml(label) + "</span>";
  }

  function renderResults(container, results) {
    if (!container) return;
    if (!results || !results.length) {
      container.innerHTML = "";
      container.hidden = true;
      return;
    }
    const rows = results
      .map((r) => {
        const status = escapeHtml(r.overall_status);
        const reasons = Array.isArray(r.reason_codes)
          ? escapeHtml(r.reason_codes.join(", "))
          : "";
        return (
          "<tr>" +
          "<td class=\"mono\">" +
          escapeHtml(r.email) +
          "</td>" +
          "<td class=\"mono\">" +
          escapeHtml(r.normalized_email) +
          "</td>" +
          "<td>" +
          escapeHtml(formatNullable(r.syntax_valid)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatNullable(r.domain_exists)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatNullable(r.mx_exists)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatNullable(r.is_disposable)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatNullable(r.is_free_provider)) +
          "</td>" +
          "<td>" +
          renderProviderLabel(r) +
          "</td>" +
          "<td>" +
          escapeHtml(formatNullable(r.is_role_based)) +
          "</td>" +
          "<td class=\"mono\">" +
          escapeHtml(r.smtp_status) +
          "</td>" +
          "<td class=\"mono\">" +
          escapeHtml(r.catch_all_status) +
          "</td>" +
          "<td><span class=\"status-pill status-" +
          status +
          "\">" +
          status +
          "</span></td>" +
          "<td>" +
          escapeHtml(r.confidence) +
          "</td>" +
          "<td class=\"mono\">" +
          reasons +
          "</td>" +
          "<td class=\"mono\">" +
          escapeHtml(r.checked_at) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    container.hidden = false;
    container.innerHTML =
      '<div class="results-table-wrap" role="region" aria-label="Verification results">' +
      '<table class="results-table">' +
      "<thead><tr>" +
      "<th scope=\"col\">email</th>" +
      "<th scope=\"col\">normalized_email</th>" +
      "<th scope=\"col\">syntax_valid</th>" +
      "<th scope=\"col\">domain_exists</th>" +
      "<th scope=\"col\">mx_exists</th>" +
      "<th scope=\"col\">is_disposable</th>" +
      "<th scope=\"col\">is_free_provider</th>" +
      "<th scope=\"col\">provider</th>" +
      "<th scope=\"col\">is_role_based</th>" +
      "<th scope=\"col\">smtp_status</th>" +
      "<th scope=\"col\">catch_all_status</th>" +
      "<th scope=\"col\">overall_status</th>" +
      "<th scope=\"col\">confidence</th>" +
      "<th scope=\"col\">reason_codes</th>" +
      "<th scope=\"col\">checked_at</th>" +
      "</tr></thead>" +
      "<tbody>" +
      rows +
      "</tbody></table></div>" +
      '<p class="hint" style="margin-top:0.75rem">Statuses describe domain-level signals. ' +
      "<strong>valid_domain</strong> does not prove the mailbox exists. " +
      "Provider labels: <em>Disposable email address</em> / <em>Free email provider</em>.</p>";
  }

  function unavailableMessage(reason) {
    if (reason === "not_configured") {
      return (
        "Verification backend is not configured for this static site. " +
        "Set API_BASE_URL in js/config.js to a self-hosted MailSure API (mailsure-api) with " +
        "OPENVERIFY_WEBSITE_API_ENABLED=true, or use the MCP tools locally. " +
        "Results are never fabricated."
      );
    }
    return (
      "Verification backend is unavailable (" +
      reason +
      "). Check that the API is running, CORS allowlists include this origin, " +
      "and the website API is enabled. No results are shown without a live backend."
    );
  }

  /** Reasons that belong on the persistent #backend-status banner only. */
  function isConnectionReason(reason) {
    return (
      reason === "not_configured" ||
      reason === "unreachable" ||
      reason === "unhealthy" ||
      reason === "invalid_health" ||
      reason === "website_api_disabled"
    );
  }

  global.MailSureApi = {
    isConfigured,
    checkHealth,
    verifyEmail,
    verifyBatch,
    renderResults,
    escapeHtml,
    unavailableMessage,
    assertValidationResult,
    isConnectionReason,
    providerTypeLabel,
  };
})(window);
