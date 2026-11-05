/**
 * Client-side CSV helpers for MailSure bulk verify.
 * Validates size, finds an email column, sanitizes formula-like cells for download.
 */
(function (global) {
  "use strict";

  const FORMULA_PREFIX = "=@+-";

  function sanitizeCsvCell(value) {
    const s = String(value ?? "");
    if (s === "") return s;
    const first = s[0];
    if (first && FORMULA_PREFIX.includes(first)) {
      return "'" + s;
    }
    return s;
  }

  function escapeCsvField(value) {
    const s = sanitizeCsvCell(value);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Minimal RFC4180-ish parser for small browser uploads.
   * @param {string} text
   * @returns {string[][]}
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let i = 0;
    let inQuotes = false;
    const input = text.replace(/^\uFEFF/, "");

    while (i < input.length) {
      const c = input[i];
      if (inQuotes) {
        if (c === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (c === ",") {
        row.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 1;
        continue;
      }
      if (c === "\r") {
        i += 1;
        continue;
      }
      field += c;
      i += 1;
    }
    row.push(field);
    if (row.length > 1 || row[0] !== "" || rows.length === 0) {
      rows.push(row);
    }
    return rows;
  }

  function findEmailColumnIndex(header) {
    const lower = header.map((h) => String(h).trim().toLowerCase());
    const preferred = ["email", "e-mail", "email_address", "email address", "mail"];
    for (const name of preferred) {
      const idx = lower.indexOf(name);
      if (idx >= 0) return idx;
    }
    // Fallback: first column that looks like it contains emails in the header name
    const fuzzy = lower.findIndex((h) => h.includes("email") || h.includes("mail"));
    return fuzzy >= 0 ? fuzzy : 0;
  }

  /**
   * @param {File} file
   * @param {{ maxBytes: number, maxEmails: number }} limits
   */
  async function extractEmailsFromCsvFile(file, limits) {
    if (!file) {
      throw new Error("No CSV file selected.");
    }
    if (!/\.csv$/i.test(file.name) && file.type && !file.type.includes("csv") && file.type !== "text/plain") {
      throw new Error("Please upload a .csv file.");
    }
    if (file.size > limits.maxBytes) {
      throw new Error(
        "CSV is too large for browser bulk verify (max " +
          Math.round(limits.maxBytes / 1024 / 1024) +
          " MiB). Use the self-hosted MCP verify_csv tool for large files.",
      );
    }
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      throw new Error("CSV needs a header row and at least one data row.");
    }
    const header = rows[0];
    const col = findEmailColumnIndex(header);
    const emails = [];
    const seen = new Set();
    for (let r = 1; r < rows.length; r += 1) {
      const cell = (rows[r][col] ?? "").trim();
      if (!cell) continue;
      const key = cell.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push(cell);
      if (emails.length > limits.maxEmails) {
        throw new Error(
          "Too many unique emails (max " +
            limits.maxEmails +
            " per browser request). Split the file or use self-hosted MCP CSV verification.",
        );
      }
    }
    if (emails.length === 0) {
      throw new Error("No email addresses found in the CSV.");
    }
    return { emails, header, emailColumn: col };
  }

  /**
   * Build a downloadable CSV from ValidationResult rows.
   * @param {Array<Record<string, unknown>>} results
   */
  function resultsToCsv(results) {
    const columns = [
      "email",
      "normalized_email",
      "syntax_valid",
      "domain_exists",
      "mx_exists",
      "is_disposable",
      "is_role_based",
      "smtp_status",
      "catch_all_status",
      "overall_status",
      "confidence",
      "reason_codes",
      "checked_at",
    ];
    const lines = [columns.map(escapeCsvField).join(",")];
    for (const row of results) {
      lines.push(
        columns
          .map((key) => {
            let v = row[key];
            if (Array.isArray(v)) v = v.join("|");
            if (v === null || v === undefined) v = "";
            return escapeCsvField(v);
          })
          .join(","),
      );
    }
    return lines.join("\n");
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  global.MailSureCsv = {
    sanitizeCsvCell,
    parseCsv,
    extractEmailsFromCsvFile,
    resultsToCsv,
    downloadText,
  };
})(window);
