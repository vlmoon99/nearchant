// Outgoing email (sign-in links, order notices) through Resend's HTTP API (ADR 0021). The API key lives in the
// Keychain / the Spark's .env (RESEND_API_KEY); sender address and API URL in config/gateway.yaml (email.*).
// Every send has a timeout, retries with backoff on 429/5xx/network errors, and an idempotency key so a retry never
// sends twice.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface Mail { to: string; subject: string; text: string; html?: string; idempotencyKey: string }
export type Mailer = (m: Mail) => Promise<void>;

export class MailError extends Error {}

export function resendMailer(o: { apiKey: string; from: string; apiUrl: string; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; tries?: number; timeoutMs?: number }): Mailer {
  const fetchFn = o.fetchFn ?? fetch, sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (m) => {
    let last = "";
    for (let i = 0; i < (o.tries ?? 3); i++) {
      if (i) await sleep(500 * 2 ** i);
      try {
        const r = await fetchFn(o.apiUrl, {
          method: "POST", signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
          headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey.slice(0, 256) },
          body: JSON.stringify({ from: o.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
        });
        if (r.ok) return;
        last = `${r.status} ${(await r.text()).slice(0, 200)}`;
        if (r.status !== 429 && r.status < 500) break; // a bad address or key will not get better by retrying
      } catch (e) { last = (e as Error).message; }
    }
    throw new MailError(`email to ${m.to.replace(/(.).*@/, "$1…@")} failed: ${last}`);
  };
}

export const normEmail = (s: string): string | null => {
  const e = s.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>"',;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e) ? e : null;
};

/** Signed one-time link token: "link" confirms an email for a store, "signin" signs in. */
export interface EmailToken { k: "link" | "signin"; h: string; e: string; exp: number; n: string }

export function signEmailToken(key: Buffer, t: Omit<EmailToken, "n">): string {
  const body = Buffer.from(JSON.stringify({ ...t, n: randomBytes(12).toString("base64url") })).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(`email:${body}`).digest("base64url")}`;
}

export function readEmailToken(key: Buffer, token: string, now = Date.now()): EmailToken | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", key).update(`email:${body}`).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString()) as EmailToken;
    return (t.k === "link" || t.k === "signin") && typeof t.h === "string" && typeof t.e === "string" && typeof t.n === "string" && t.exp > now ? t : null;
  } catch { return null; }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain, readable email with one button. */
export function emailHtml(o: { title: string; lines: string[]; button?: { label: string; url: string }; foot?: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:520px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border-radius:16px;padding:28px">
<div style="font-weight:600;font-size:17px;margin-bottom:18px"><span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:7px;background:#121916;color:#00ec97;margin-right:8px">N</span>Nearchant</div>
<h1 style="font-size:22px;margin:0 0 12px">${esc(o.title)}</h1>
${o.lines.map((l) => `<p style="font-size:15px;line-height:1.45;margin:0 0 10px">${esc(l)}</p>`).join("")}
${o.button ? `<p style="margin:22px 0"><a href="${esc(o.button.url)}" style="display:inline-block;background:#007aff;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${esc(o.button.label)}</a></p>` : ""}
${o.foot ? `<p style="font-size:12px;color:#6e6e73;margin:16px 0 0">${esc(o.foot)}</p>` : ""}
</div></div></body></html>`;
}
