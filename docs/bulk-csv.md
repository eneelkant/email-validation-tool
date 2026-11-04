# Bulk CSV processing — OpenVerify MCP

Tool: `verify_csv`. Pipeline (bounded memory):

`Read stream → parse → batch (≤ OPENVERIFY_CSV_BATCH_SIZE, cap 1000) → validate → ordered write`

## Inputs

- Paths must pass `assertSafeUserPath` allowlists (see [Security configuration — CSV path allowlists](./security-config.md#csv-path-allowlists)): input under `OPENVERIFY_UPLOAD_DIR`, `OPENVERIFY_DATA_DIR`, or process CWD; output under `OPENVERIFY_OUTPUT_DIR`, `OPENVERIFY_DATA_DIR`, or process CWD. Traversal outside those roots is rejected.
- Size limited by `OPENVERIFY_MAX_CSV_BYTES` (default 100 MiB) — not unlimited.
- Email column: set MCP `email_column` for a preferred header, or rely on auto-detect (`email`, `e-mail`, `mail`, `email_address`, `emailaddress`, `address`). If no preferred column is set and no known header matches, **the first column is used** (no error). Prefer an explicit `email_column` for nonstandard headers.
- Original columns preserved; validation columns appended.
- Formula-like cells (`=`, `+`, `-`, `@` prefixes) are neutralized in output.

## MCP example

```json
{
  "name": "verify_csv",
  "arguments": {
    "input_path": "/absolute/path/under/uploads/list.csv",
    "email_column": "email",
    "wait": true,
    "concurrency": 8
  }
}
```

Then poll `get_validation_job` / `cancel_validation_job` when `wait` is false.

### First-column fallback

With headers `name,contact` and no `email_column`, OpenVerify validates the `name` column (first header) instead of failing. Pass `email_column: "contact"` when the address column is nonstandard.

## Sample CSV

```csv
name,email,company
Ada,ada@example.com,"Acme, Inc."
Bad,not-an-email,Acme
Role,admin@example.com,Acme
```

## Behaviors verified in tests

Covered by `tests/csv-streaming.test.ts` / `tests/batch-csv.test.ts`:

| Scenario | Expected |
|----------|----------|
| Small / multi-batch | Completes; row order and original columns preserved |
| Quoted fields / UTF-8 BOM | Completes; commas inside quotes handled |
| Large (thousands of rows) | Completes with peak buffered rows ≤ batch size |
| Empty file | Finishes (`completed` or `failed`) — does not hang |
| Missing preferred `email_column` | `failed` with clear error |
| Cancellation | Status `cancelled`; stops new batches; flushes completed output |
| Sparse/partial batch results | Treated as cancellation path; no `undefined` output rows |
| Output path write failure | Status `failed` |
| Formula-like cells | Leading `=@+-` neutralized in output |

## Implemented behavior (not covered by automated tests)

These behaviors exist in `src/processing/csv.ts` but currently have **no** dedicated automated assertions:

| Scenario | Implementation note |
|----------|---------------------|
| Malformed quotes | Parser errors are caught and mark the job `failed` |
| Duplicate emails | No dedupe step — duplicate input rows are written through as separate rows |
| Backpressure | `writeRowWithBackpressure` waits for stream `drain` (or fails on writer `error`) when `write` returns false |

## Operational tips

- Prefer `OPENVERIFY_CSV_BATCH_SIZE=50–100` for large files on memory-constrained hosts.
- Keep SMTP disabled for bulk third-party lists.
- Measure throughput on your hardware; the project does not publish fabricated benchmark numbers.
