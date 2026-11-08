// The voice: any function that turns text into audio plus per-word timings. `httpTts` is an adapter for the service
// Nearchant runs (Kokoro-82M voice + faster-whisper word timestamps, a small FastAPI app):
//   POST /generate   {text, lang, product_id, voice?, speed?} → {audio: {path, duration_s}}
//   GET  /files/<path>                                       → the WAV
//   POST /transcribe {path, lang, word_timestamps: true}     → {words: [{word, start, end}]}
// Bring your own (ElevenLabs with timestamps, OpenAI TTS + Whisper…): return the same `Speech` shape.
import type { Word } from "./captions.js";

export interface Speech {
  /** Audio bytes ffmpeg can read (WAV, MP3…). */
  audio: Uint8Array;
  /** Word timings in seconds; may be empty (then there are no captions). */
  words: Word[];
  /** Length of the audio in seconds. */
  seconds: number;
}
/** `id` groups files on the TTS side (Nearchant passes the store handle). */
export type Tts = (text: string, id: string) => Promise<Speech>;

export interface HttpTtsOptions {
  baseUrl: string;
  /** Sent as "Authorization: Bearer …". */
  apiKey?: string;
  lang?: string;
  voice?: string;
  speed?: number;
  /** Extra attempts on network errors and 5xx. Default 2. */
  retries?: number;
  backoffMs?: number;
  /** Synthesis and transcription. Default 120 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Keeps only well-formed word timings. */
export function readWords(raw: unknown): Word[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((w): w is Word => !!w && typeof w === "object" && typeof (w as Word).word === "string" && Number.isFinite((w as Word).start) && Number.isFinite((w as Word).end))
    .map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
}

export function httpTts(o: HttpTtsOptions): Tts {
  const f = o.fetch ?? fetch, base = o.baseUrl.replace(/\/+$/, ""), tries = (o.retries ?? 2) + 1, timeout = o.timeoutMs ?? 120_000;
  const headers = { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) };
  async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await f(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return r;
        last = new Error(`tts ${path.split("?")[0]}: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
        if (r.status < 500) break; // a bad request will not get better
      } catch (e) { last = e; }
      if (i < tries - 1) await new Promise((res) => setTimeout(res, (o.backoffMs ?? 1000) * 2 ** i));
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
  return async (text, id) => {
    const productId = id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "adhoc";
    const g = (await (await call("/generate", { method: "POST", body: JSON.stringify({ text, lang: o.lang ?? "en", product_id: productId, ...(o.voice ? { voice: o.voice } : {}), ...(o.speed ? { speed: o.speed } : {}) }) }, timeout)).json()) as { audio?: { path?: unknown; duration_s?: unknown } };
    const path = g.audio?.path, seconds = Number(g.audio?.duration_s);
    if (typeof path !== "string" || !path || path.includes("..") || !(seconds > 0)) throw new Error("tts /generate: no audio path or duration in the answer");
    const [audio, tr] = await Promise.all([
      call(`/files/${path.split("/").map(encodeURIComponent).join("/")}`, {}, 30_000).then(async (r) => new Uint8Array(await r.arrayBuffer())),
      call("/transcribe", { method: "POST", body: JSON.stringify({ path, lang: o.lang ?? "en", word_timestamps: true }) }, timeout).then((r) => r.json() as Promise<{ words?: unknown }>),
    ]);
    return { audio, words: readWords(tr.words), seconds };
  };
}
