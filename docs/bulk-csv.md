# Bulk CSV processing — OpenVerify MCP

Tool: `verify_csv`. Pipeline (bounded memory):

`Read stream → parse → batch (≤ OPENVERIFY_CSV_BATCH_SIZE, cap 1000) → validate → ordered write`

## Inputs

- Paths must resolve under configured upload/output roots (path traversal rejected).
- Size limited by `OPENVERIFY_MAX_CSV_BYTES` (default 100 MiB).
- Email column auto-detected (`email`, `e-mail`, `mail`, …) or set via MCP `email_column`.
- Original columns preserved; validation columns appended.
- Formula-like cells (`=`, `+`, `-`, `@` prefixes) are neutralized in output.

## MCP example

```json
{
  "name": "verify_csv",
  "arguments": {
    "input_path": "/absolute/path/under/uploads/list.csv",
    "wait": true,
    "concurrency": 8
  }
}
```

Then poll `get_validation_job` / `cancel_validation_job` when `wait` is false.

## Sample CSV

```csv
name,email,company
Ada,ada@example.com,"Acme, Inc."
Bad,not-an-email,Acme
Role,admin@example.com,Acme
```

## Behaviors verified in tests

| Scenario | Expected |
|----------|----------|
| Small / multi-batch | Completes; row order preserved |
| Large (thousands of rows) | Completes with peak buffered rows ≤ batch size |
| Empty file | Finishes (`completed` or `failed`) — does not hang |
| Missing preferred email column | `failed` with clear error |
| Malformed quotes | `failed` with parser error |
| Duplicate emails | All rows retained (no silent dedupe) |
| Cancellation | Status `cancelled`; stops new batches; flushes completed output |
| Output path write failure | Status `failed` |
| Backpressure | Writer waits on `drain` (no unbounded buffer growth) |

## Operational tips

- Prefer `OPENVERIFY_CSV_BATCH_SIZE=50–100` for large files on memory-constrained hosts.
- Keep SMTP disabled for bulk third-party lists.
- Measure throughput on your hardware; the project does not publish fabricated benchmark numbers.
