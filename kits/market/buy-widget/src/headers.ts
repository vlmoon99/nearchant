// HTTP headers for the widget. The widget page must be frameable by ANY site, including a file:// page an owner
// opens locally to try the snippet. `frame-ancestors *` still refuses file:// (and X-Frame-Options can't allow
// "anyone"), so the widget sends no frame-ancestors and no X-Frame-Options at all. That is safe because the
// frame holds no session or cookie and its buttons only open your site in a new tab.

export interface WidgetHeaderOptions {
  /** Extra image origins for item photos (CSP img-src). "https:" is already allowed. */
  imgSrc?: string[];
  /** Extra script origins, if FRAME_JS is served from another host. */
  scriptSrc?: string[];
}

/** Headers for the widget HTML page (renderWidget / renderMissing). */
export function widgetHeaders(o: WidgetHeaderOptions = {}): Record<string, string> {
  const csp = [
    "default-src 'self'",
    `script-src ${["'self'", ...(o.scriptSrc ?? [])].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${["'self'", "data:", "https:", ...(o.imgSrc ?? [])].join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "public, max-age=60",
  };
}

/** Headers for the loader script (embed.js) that other sites include: cacheable, readable cross-origin. */
export function loaderHeaders(): Record<string, string> {
  return {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=3600",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  };
}

/** Headers for the frame script (embed-frame.js). */
export function frameScriptHeaders(): Record<string, string> {
  return { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" };
}

/** True for widget pages under `prefix` (default "/embed"): use it to pick widgetHeaders over your normal headers,
 *  which probably say frame-ancestors 'none'. */
export const isWidgetPath = (path: string, prefix = "/embed") => path === prefix || path.startsWith(`${prefix}/`);
