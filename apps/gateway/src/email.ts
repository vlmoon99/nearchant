// Outgoing email (sign-in links, order notices) through Resend's HTTP API (ADR 0021). The API key lives in the
// Keychain / the Spark's .env (RESEND_API_KEY); sender address and API URL in config/gateway.yaml (email.*).
// Every send has a timeout, retries with backoff on 429/5xx/network errors, and an idempotency key so a retry never
// sends twice.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export { MailError, emailHtml, resendMailer, type Mail, type Mailer } from "@nearchant/db";

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

