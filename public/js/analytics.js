/**
 * MailSure analytics helpers — GTM dataLayer only (no hardcoded gtag/GA4).
 *
 * Privacy: never push email addresses, CSV contents, filenames, or other PII.
 * GA4 collection becomes active only after the GTM Google Tag is configured
 * in the GTM workspace (not claimed by this frontend alone).
 */
(function (global) {
  "use strict";

  var BLOCKED_KEYS = {
    email: true,
    emails: true,
    normalized_email: true,
    csv: true,
    content: true,
    text: true,
    file: true,
    filename: true,
    file_name: true,
    name: true,
    value: true,
    input: true,
    payload: true,
    body: true,
    raw: true,
    token: true,
    authorization: true,
  };

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Drop blocked keys and non-primitive nested objects so PII cannot leak.
   * Allows strings, numbers, booleans, and null only (plus shallow copies).
   */
  function sanitizeParams(params) {
    if (!isPlainObject(params)) return {};
    var out = {};
    Object.keys(params).forEach(function (key) {
      var lower = String(key).toLowerCase();
      if (BLOCKED_KEYS[lower]) return;
      if (/email|token|auth|password|secret|csv|content|filename/i.test(lower)) return;
      var val = params[key];
      var t = typeof val;
      if (val === null || t === "string" || t === "number" || t === "boolean") {
        out[key] = val;
      }
    });
    return out;
  }

  /**
   * @param {string} eventName
   * @param {Record<string, unknown>} [params]
   */
  function pushEvent(eventName, params) {
    if (!eventName || typeof eventName !== "string") return;
    global.dataLayer = global.dataLayer || [];
    var payload = sanitizeParams(params || {});
    payload.event = eventName;
    global.dataLayer.push(payload);
  }

  global.MailSureAnalytics = Object.freeze({
    pushEvent: pushEvent,
    sanitizeParams: sanitizeParams,
  });
})(typeof window !== "undefined" ? window : globalThis);
