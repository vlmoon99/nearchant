// Client of the English voice service (deploy/video-engine/tts: Kokoro-82M + faster-whisper word timings).
import type { Word } from "./video-compose.js";

export interface Tts { speak(text: string, id: string): Promise<{ wav: Buffer; words: Word[]; seconds: number }> }

export function makeTts(base: string, apiKey = "", fetchFn: typeof fetch = fetch, tries = 3): Tts {
  const h = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetchFn(`${base}${path}`, { ...init, headers: h, signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return r;
        last = new Error(`tts ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
        if (r.status < 500) break; // a bad request will not get better
      } catch (e) { last = e; }
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
  return {
    async speak(text, id) {
      const g = (await (await call("/generate", { method: "POST", body: JSON.stringify({ text, lang: "en", product_id: id }) }, 120_000)).json()) as { audio: { path: string; duration_s: number } };
      const [wav, tr] = await Promise.all([
        call(`/files/${g.audio.path}`, {}, 30_000).then(async (r) => Buffer.from(await r.arrayBuffer())),
        call("/transcribe", { method: "POST", body: JSON.stringify({ path: g.audio.path, lang: "en", word_timestamps: true }) }, 120_000).then((r) => r.json() as Promise<{ words?: Word[] }>),
      ]);
      return { wav, words: tr.words ?? [], seconds: g.audio.duration_s };
    },
  };
}
