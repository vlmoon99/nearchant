// ComfyUI client for Comfy Cloud (https://cloud.comfy.org/api, X-API-Key) or a self-hosted ComfyUI
// (http://host:8188): upload the photo → queue the workflow → poll until done → download the first output file.
// Images, animated WEBP/WEBM and videos all come back the same way, so the same client renders clips too.

/** A ComfyUI workflow in API format ("Save (API)" in ComfyUI): node id → { class_type, inputs }. */
export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>;

export class ComfyError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); this.name = "ComfyError"; }
}

export interface FillValues { prompt: string; ref?: string; seed: number; width: number; height: number; set?: Record<string, string | number> }

/** Fills the placeholders (__PROMPT__, __REF__, __SEED__, __WIDTH__, __HEIGHT__) and applies "<node>.<input>"
 *  overrides. Returns a new graph; the template is untouched. */
export function fillWorkflow(template: Workflow, v: FillValues): Workflow {
  const wf = JSON.parse(JSON.stringify(template)) as Workflow;
  const map: Record<string, unknown> = { __PROMPT__: v.prompt, __REF__: v.ref ?? "", __SEED__: v.seed, __WIDTH__: v.width, __HEIGHT__: v.height };
  for (const node of Object.values(wf)) {
    for (const [k, val] of Object.entries(node.inputs)) if (typeof val === "string" && val in map) node.inputs[k] = map[val];
  }
  for (const [path, val] of Object.entries(v.set ?? {})) {
    const [id, input] = path.split(".");
    if (!id || !input || !wf[id]) throw new Error(`override ${path}: no node ${id}`);
    wf[id]!.inputs[input] = val;
  }
  return wf;
}

/** True when the workflow expects an uploaded photo (has a __REF__ placeholder). */
export const needsPhoto = (template: Workflow) => JSON.stringify(template).includes('"__REF__"');

export interface ComfyOptions {
  /** Default "https://cloud.comfy.org/api". A self-hosted ComfyUI: "http://127.0.0.1:8188" with api: "comfyui". */
  baseUrl?: string;
  /** Comfy Cloud key (sent as X-API-Key). */
  apiKey?: string;
  /** Which API: Comfy Cloud's job endpoints or a plain ComfyUI's /history. Default "cloud". */
  api?: "cloud" | "comfyui";
  /** Per request. Default 60 s. */
  requestTimeoutMs?: number;
  /** For the final file. Default 120 s. */
  downloadTimeoutMs?: number;
  /** Default 2 s. */
  pollIntervalMs?: number;
  /** Give up on a job after this long. Default 10 min. */
  maxWaitMs?: number;
  /** Retries for safe calls (upload with overwrite, status, download). Default 2. */
  retries?: number;
  /** First backoff; doubles. Default 1000 ms. */
  backoffMs?: number;
  /** Retries for queueing a job. Default 0: a retried queue call may run (and bill) the job twice. */
  queueRetries?: number;
  fetch?: typeof fetch;
}

const PLAIN: Record<number, string> = { 401: "the Comfy Cloud key is wrong", 402: "Comfy Cloud is out of credits", 429: "the Comfy Cloud subscription is not active or is rate-limited" };
const DONE = ["success", "error", "non_retryable_error", "lost", "cancelled"];
type OutFile = { filename: string; subfolder?: string; type?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ComfyClient {
  private o: Required<Omit<ComfyOptions, "apiKey">> & { apiKey?: string };
  constructor(options: ComfyOptions = {}) {
    this.o = {
      baseUrl: (options.baseUrl ?? "https://cloud.comfy.org/api").replace(/\/+$/, ""), api: options.api ?? "cloud",
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000, downloadTimeoutMs: options.downloadTimeoutMs ?? 120_000,
      pollIntervalMs: options.pollIntervalMs ?? 2000, maxWaitMs: options.maxWaitMs ?? 600_000, retries: options.retries ?? 2,
      backoffMs: options.backoffMs ?? 1000, queueRetries: options.queueRetries ?? 0, fetch: options.fetch ?? fetch,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    };
  }
  private h(): Record<string, string> { return this.o.apiKey ? { "X-API-Key": this.o.apiKey } : {}; }
  private err(what: string, status: number, detail = "") {
    return new ComfyError(`${what}: ${PLAIN[status] ?? `HTTP ${status}`}${detail ? ` ${detail.slice(0, 300)}` : ""}`, status, status === 429 || status >= 500);
  }

  /** Runs `fn`, retrying network errors, timeouts, 429 and 5xx with exponential backoff. */
  private async retry<T>(fn: () => Promise<T>, retries = this.o.retries): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        const retryable = e instanceof ComfyError ? e.retryable : true; // fetch threw: network or timeout
        if (!retryable || i >= retries) throw e instanceof ComfyError ? e : new ComfyError(`request failed: ${(e as Error).message}`, undefined, true);
        await sleep(this.o.backoffMs * 2 ** i);
      }
    }
  }

  /** Uploads a picture as a workflow input; returns the name to put in LoadImage (__REF__). */
  async upload(bytes: Uint8Array, name: string, type = "image/png"): Promise<string> {
    return this.retry(async () => {
      const fd = new FormData();
      fd.append("image", new Blob([new Uint8Array(bytes)], { type }), name);
      fd.append("overwrite", "true"); fd.append("type", "input"); // overwrite → a retried upload is harmless
      const r = await this.o.fetch(`${this.o.baseUrl}/upload/image`, { method: "POST", headers: this.h(), body: fd, signal: AbortSignal.timeout(this.o.requestTimeoutMs) });
      if (!r.ok) throw this.err("upload", r.status, await r.text().catch(() => ""));
      const j = (await r.json()) as { name?: unknown; subfolder?: unknown };
      if (typeof j.name !== "string") throw new ComfyError("upload: no file name in the answer");
      return typeof j.subfolder === "string" && j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
    });
  }

  /** Queues a filled workflow; returns its prompt id. */
  async queue(wf: Workflow): Promise<string> {
    return this.retry(async () => {
      const r = await this.o.fetch(`${this.o.baseUrl}/prompt`, { method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify({ prompt: wf }), signal: AbortSignal.timeout(this.o.requestTimeoutMs) });
      const j = (await r.json().catch(() => ({}))) as { prompt_id?: unknown; error?: unknown; node_errors?: unknown };
      if (!r.ok || typeof j.prompt_id !== "string") throw this.err("prompt", r.status, JSON.stringify(j.error ?? j.node_errors ?? j));
      return j.prompt_id;
    }, this.o.queueRetries);
  }

  /** One status look: null while running, the output files when done; throws when the job failed. */
  private async look(pid: string): Promise<OutFile[] | null> {
    const get = async (path: string) => {
      const r = await this.o.fetch(`${this.o.baseUrl}${path}`, { headers: this.h(), signal: AbortSignal.timeout(this.o.requestTimeoutMs) });
      if (!r.ok) throw this.err(path, r.status);
      return (await r.json()) as unknown;
    };
    let outputs: Record<string, Record<string, unknown>> | undefined;
    if (this.o.api === "cloud") {
      const s = (await get(`/job/${pid}/status`)) as { status?: string };
      if (!s.status || !DONE.includes(s.status)) return null;
      if (s.status !== "success") throw new ComfyError(`job ended as ${s.status}`);
      outputs = ((await this.retry(() => get(`/jobs/${pid}`))) as { outputs?: typeof outputs }).outputs;
    } else {
      const h = ((await get(`/history/${pid}`)) as Record<string, { outputs?: typeof outputs; status?: { status_str?: string; completed?: boolean; messages?: unknown } }>)[pid];
      if (!h?.status?.completed && h?.status?.status_str !== "error") return null;
      if (h.status.status_str === "error") throw new ComfyError(`job failed: ${JSON.stringify(h.status.messages ?? "").slice(0, 300)}`);
      outputs = h.outputs;
    }
    // Images, animated WEBP/WEBM and videos are all listed as files under some output key.
    const files = Object.values(outputs ?? {}).flatMap((o) => Object.values(o ?? {}).filter(Array.isArray).flat() as OutFile[]).filter((f) => f && typeof f.filename === "string");
    if (!files.length) throw new ComfyError("the job has no output file");
    return files;
  }

  /** Polls until the job is done (status errors count as "still running"); returns its output files. */
  async wait(pid: string, onStatus?: (s: string) => void): Promise<OutFile[]> {
    const until = Date.now() + this.o.maxWaitMs;
    while (Date.now() < until) {
      await sleep(this.o.pollIntervalMs);
      try {
        const files = await this.look(pid);
        if (files) return files;
        onStatus?.("running");
      } catch (e) {
        if (e instanceof ComfyError && e.status === undefined && !e.retryable) throw e; // the job itself failed
        onStatus?.(`status check failed: ${(e as Error).message}`);
      }
    }
    throw new ComfyError(`timed out after ${Math.round(this.o.maxWaitMs / 1000)} s`);
  }

  /** Downloads an output file. Comfy Cloud answers /view with a redirect to a signed link (fetched without the key). */
  async download(f: OutFile): Promise<Uint8Array> {
    return this.retry(async () => {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
      const v = await this.o.fetch(`${this.o.baseUrl}/view?${q}`, { headers: this.h(), redirect: "manual", signal: AbortSignal.timeout(this.o.downloadTimeoutMs) });
      if (v.ok) return new Uint8Array(await v.arrayBuffer()); // self-hosted ComfyUI serves the file itself
      const loc = v.status >= 300 && v.status < 400 ? v.headers.get("location") : null;
      if (!loc) throw this.err("view", v.status);
      const r = await this.o.fetch(loc, { signal: AbortSignal.timeout(this.o.downloadTimeoutMs) });
      if (!r.ok) throw this.err("download", r.status);
      return new Uint8Array(await r.arrayBuffer());
    });
  }

  /** Queue → wait → download the first output. */
  async run(wf: Workflow, onStatus?: (s: string) => void): Promise<{ bytes: Uint8Array; filename: string }> {
    const pid = await this.queue(wf);
    onStatus?.(`queued ${pid}`);
    const [first] = await this.wait(pid, onStatus);
    return { bytes: await this.download(first!), filename: first!.filename };
  }
}
