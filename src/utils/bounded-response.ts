/**
 * Read an HTTP response body with a hard byte cap.
 * Content-Length is an early reject only — the stream is always counted.
 */

export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(maxBytes: number, receivedBytes: number, detail?: string) {
    super(
      detail ??
        `Response body exceeds max ${maxBytes} bytes (received ≥ ${receivedBytes})`,
    );
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

function parseContentLength(header: string | null): number | null {
  if (header === null || header === '') return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Read response text while enforcing maxBytes.
 * Aborts/cancels the body stream as soon as the cap is exceeded.
 */
export async function readResponseTextLimited(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const declared = parseContentLength(res.headers.get('content-length'));
  if (declared !== null && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new ResponseTooLargeError(
      maxBytes,
      declared,
      `Content-Length ${declared} exceeds max ${maxBytes} bytes`,
    );
  }

  // Prefer streaming so oversized bodies never fully buffer.
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new ResponseTooLargeError(maxBytes, total);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw err;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw err;
    }

    if (total === 0) return '';
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return buf.toString('utf8');
  }

  // Fallback for odd Response mocks without a body stream.
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new ResponseTooLargeError(maxBytes, buf.byteLength);
  }
  return buf.toString('utf8');
}
