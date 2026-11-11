// Review translations (ADR 0029): only in builds with UI_LANGS beyond "en" (production is English only).
// The server puts this script, with the chosen language's dictionary, first in <head>. It translates the interface
// text as the page is parsed and whatever the scripts add later. Unknown text, such as store names, captions and
// prices, stays as written.
type Dict = Record<string, string>;
declare global { interface Window { __ncI18n?: { lang: string; dict: Dict; langs: string[] } } }

const cfg = window.__ncI18n;
if (cfg && cfg.lang !== "en") {
  const D = cfg.dict;
  const esc = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  // Keys with {0}… become patterns; the most specific (longest literal text) first.
  const T = Object.keys(D).filter((k) => /\{\d+\}/.test(k) && k.replace(/\{\d+\}/g, "").replace(/[^A-Za-z]/g, "").length >= 3)
    .sort((a, b) => b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length)
    .map((k) => { const order: number[] = []; const re = new RegExp(`^${k.split(/(\{\d+\})/).map((p) => { const m = /^\{(\d+)\}$/.exec(p); if (m) { order.push(Number(m[1])); return "(.+?)"; } return esc(p); }).join("")}$`); return { re, order, out: D[k]! }; });
  const fill = (out: string, vals: string[]) => out.replace(/\{(\d+)\}/g, (_, i) => vals[Number(i)] ?? "");
  const lookup = (k: string, depth = 0): string | undefined => {
    const v = D[k];
    if (v !== undefined) return v;
    const nums: string[] = [];
    const kn = k.replace(/\d[\d,.]*/g, (m) => `{${nums.push(m) - 1}}`);
    if (nums.length && D[kn] !== undefined) return fill(D[kn]!, nums);
    if (depth > 1) return undefined;
    for (const t of T) {
      const m = t.re.exec(k);
      if (!m) continue;
      const vals: string[] = [];
      t.order.forEach((idx, j) => { const x = m[j + 1]!; vals[idx] = lookup(x.trim(), depth + 1) ?? x; });
      return fill(t.out, vals);
    }
    return undefined;
  };
  // "Nov 11 · paid out · on NEAR": a joined label is translated part by part when the whole isn't known.
  const parts = (k: string): string | undefined => {
    for (const sep of [" · ", " — ", ": "]) {
      if (!k.includes(sep)) continue;
      const xs = k.split(sep), ys = xs.map((x) => (/[A-Za-z]/.test(x) ? lookup(x.trim()) ?? parts(x.trim()) : x));
      if (ys.some((y, i) => y !== undefined && y !== xs[i])) return ys.map((y, i) => y ?? xs[i]).join(sep);
    }
    return undefined;
  };
  const tr = (s: string): string | null => {
    const k = s.replace(/\s+/g, " ").trim();
    if (!k || !/[A-Za-z]/.test(k)) return null;
    const v = lookup(k) ?? parts(k);
    if (v === undefined || v === k) return null;
    return (/^\s/.test(s) ? " " : "") + v + (/\s$/.test(s) ? " " : "");
  };
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "NOSCRIPT"]);
  const skip = (el: Element | null): boolean => { for (let e = el; e; e = e.parentElement) { if (SKIP.has(e.tagName) || e.hasAttribute("data-no-tr") || (e as HTMLElement).isContentEditable) return true; } return false; };
  const done = new WeakMap<Node, string>(); // what we wrote, so our own change isn't translated again
  const text = (n: Text) => {
    if (done.get(n) === n.data || skip(n.parentElement)) return;
    const v = tr(n.data);
    if (v !== null) { done.set(n, v); n.data = v; }
  };
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  const attrs = (el: Element) => {
    for (const a of ATTRS) { const x = el.getAttribute(a); if (x) { const v = tr(x); if (v !== null) el.setAttribute(a, v); } }
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") && el.value) { const v = tr(el.value); if (v !== null) el.value = v; }
  };
  const walk = (root: Node) => {
    if (root.nodeType === 3) { text(root as Text); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skip(root as Element)) return; attrs(root as Element); }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) text(n as Text); else attrs(n as Element); }
  };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "characterData") text(m.target as Text);
      else if (m.type === "attributes") { const el = m.target as Element; if (!skip(el)) { const x = el.getAttribute(m.attributeName!); const v = x ? tr(x) : null; if (v !== null) el.setAttribute(m.attributeName!, v); } }
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // Messages from the scripts (alert / confirm) too.
  const al = window.alert.bind(window), cf = window.confirm.bind(window);
  window.alert = (m?: unknown) => al(typeof m === "string" ? tr(m) ?? m : m);
  window.confirm = (m?: string) => cf(typeof m === "string" ? tr(m) ?? m : m);
  document.addEventListener("DOMContentLoaded", () => walk(document.documentElement));
}
export {};
