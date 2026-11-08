// Escaping for the three places item data lands in the widget: HTML text, attribute values and a CSS url().
// Item titles, image URLs and store names come from sellers: treat them as untrusted.

const HTML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text or a quoted attribute value. */
export const escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML[c]!);

/** Only http(s) and same-site paths; anything else (javascript:, data:, vbscript:) becomes "#". */
export function safeUrl(u: unknown): string {
  const s = String(u ?? "").trim();
  if (/^\/(?!\/)/.test(s) || /^\.\.?\//.test(s)) return s;
  try {
    const p = new URL(s);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : "#";
  } catch {
    return "#";
  }
}

/** A URL inside `url('…')` in a style attribute: safe URL, then percent-encode what could end the string or call. */
export const cssUrl = (u: unknown) => safeUrl(u).replace(/['"()\\\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** A JSON value placed inside a <script> or a JS string we serve: no "</script>", no line separators. */
export const jsLiteral = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
