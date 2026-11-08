// Word-timed captions: the TTS service's word timings, the script's words, cut into short readable chunks.

export interface Word { word: string; start: number; end: number }

const MAX_GAP_S = 0.6, MIN_SHOW_S = 0.3;

/** Whisper's TIMING, the script's TEXT: re-transcribing our own voiceover sometimes mishears, but we know what was
 *  said. Script words are laid on the timeline by their share of the characters, so pace and pauses carry over even
 *  when the word counts differ. */
export function alignToScript(words: Word[], script: string): Word[] {
  const spoken = (script ?? "").split(/\s+/).filter(Boolean);
  const timed = words.filter((w) => w.word.trim() && w.end >= w.start && w.start >= 0).map((w) => ({ n: Math.max(w.word.trim().length, 1), s: w.start, e: w.end }));
  if (!spoken.length || !timed.length) return words;
  if (spoken.length === timed.length) return spoken.map((word, i) => ({ word, start: timed[i]!.s, end: timed[i]!.e }));
  const totalW = timed.reduce((a, x) => a + x.n, 0), totalS = spoken.reduce((a, w) => a + w.length, 0);
  const at = (pos: number) => {
    let acc = 0;
    for (const x of timed) { if (pos <= acc + x.n) return x.s + ((x.e - x.s) * Math.max(pos - acc, 0)) / x.n; acc += x.n; }
    return timed.at(-1)!.e;
  };
  let acc = 0;
  return spoken.map((word) => { const a = acc; acc += word.length; return { word, start: at((a / totalS) * totalW), end: at((acc / totalS) * totalW) }; });
}

/** Caption chunks: ≤3 words / 18 characters; a pause (> 0.6 s) or a sentence end starts a new one; each shows at
 *  least 0.3 s, is held until the next one starts (≤ +0.6 s) and never overlaps it. */
export function captionChunks(words: Word[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) out.push({ text: cur.map((w) => w.word).join(" "), start: cur[0]!.start, end: Math.max(cur.at(-1)!.end, cur[0]!.start + MIN_SHOW_S) }); cur = []; };
  for (const w of words.filter((x) => x.word.trim())) {
    const text = [...cur, w].map((x) => x.word).join(" ");
    if (cur.length && (cur.length >= 3 || text.length > 18 || w.start - cur.at(-1)!.end > MAX_GAP_S)) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.word)) flush();
  }
  flush();
  return out.map((c, i) => ({ ...c, end: Math.min(out[i + 1]?.start ?? c.end + 0.3, c.end + 0.6) }));
}
