import type { MiddlewareHandler } from "hono";

/**
 * CORS for `/public/*` (architecture.md §9): reflect `Access-Control-Allow-Origin` only for an exact match
 * against the allowlist, never `*`, never credentials. Answers Private Network Access preflights only for
 * allowlisted origins. A disallowed preflight gets 403; a disallowed simple request gets no CORS headers, so
 * the browser blocks it.
 */
export function publicCors(allowed: (c: Parameters<MiddlewareHandler>[0]) => Promise<Set<string>>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const ok = origin ? (await allowed(c)).has(origin) : false;
    if (c.req.method === "OPTIONS") {
      c.header("Vary", "Origin");
      if (!ok) return c.body(null, 403);
      c.header("Access-Control-Allow-Origin", origin!);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "content-type");
      c.header("Access-Control-Max-Age", "600");
      if (c.req.header("access-control-request-private-network") === "true") {
        c.header("Access-Control-Allow-Private-Network", "true");
      }
      return c.body(null, 204);
    }
    await next();
    c.header("Vary", "Origin", { append: true });
    if (ok) c.header("Access-Control-Allow-Origin", origin!);
  };
}

export function originOf(url: string): string {
  return new URL(url).origin;
}
