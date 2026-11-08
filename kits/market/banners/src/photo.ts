import { readFile } from "node:fs/promises";

export interface PhotoOptions {
  /** Timeout per download try. Default 10 s. */
  timeoutMs?: number;
  /** Extra tries for a URL after a network error or a 5xx/429 (GET is safe to repeat). Default 2. */
  retries?: number;
  /** Largest photo accepted. Default 20 MB. */
  maxBytes?: number;
  /** fetch to use (tests, proxies). Default global fetch. */
  fetch?: typeof fetch;
}

/** A photo as a Buffer, a file path, an http(s) URL, or nothing. */
export type PhotoSource = Buffer | Uint8Array | string | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loads a photo. Throws on a bad URL response, a missing file or an oversized photo. */
export async function loadPhoto(src: PhotoSource, o: PhotoOptions = {}): Promise<Buffer | null> {
  if (src == null || src === "") return null;
  const max = o.maxBytes ?? 20 * 1024 * 1024;
  if (typeof src !== "string") {
    if (src.byteLength > max) throw new Error(`photo is larger than ${max} bytes`);
    return Buffer.from(src);
  }
  if (!/^https?:\/\//i.test(src)) {
    const b = await readFile(src);
    if (b.byteLength > max) throw new Error(`photo is larger than ${max} bytes`);
    return b;
  }
  const f = o.fetch ?? fetch, retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await f(src, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), redirect: "follow" });
      if (!res.ok) {
        const err = new Error(`photo ${src}: HTTP ${res.status}`);
        if (res.status >= 500 || res.status === 429) throw Object.assign(err, { retry: true });
        throw err;
      }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > max) throw new Error(`photo is larger than ${max} bytes`);
      const b = Buffer.from(await res.arrayBuffer());
      if (b.byteLength > max) throw new Error(`photo is larger than ${max} bytes`);
      return b;
    } catch (e) {
      // Retry network errors, timeouts and 5xx/429; not 404s or oversized photos.
      const retryable = (e as { retry?: boolean }).retry === true || !(e instanceof Error && /HTTP \d|larger than/.test(e.message));
      if (!retryable || attempt >= retries) throw e;
      await sleep(300 * 2 ** attempt);
    }
  }
}
