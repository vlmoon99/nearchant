// Contact details instead of an in-app chat: the buyer leaves a phone (with the messenger they use) or an email at
// checkout; only that seller sees it and contacts them in their own app.
import { normEmail } from "./email.js";

export const APPS = { whatsapp: "WhatsApp", telegram: "Telegram", signal: "Signal", viber: "Viber", imessage: "iMessage", sms: "SMS / call" } as const;
export type ContactApp = keyof typeof APPS;
export interface Contact { name?: string; email?: string; phone?: string; app?: ContactApp; address?: string }
export interface ContactLink { label: string; value: string; href: string }

const isApp = (v: unknown): v is ContactApp => typeof v === "string" && Object.hasOwn(APPS, v);
const appOf = (c: Contact): ContactApp => (isApp(c.app) ? c.app : "sms");
/** Trims, collapses whitespace and cuts to `max`; anything that isn't a string becomes "". */
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** "+971 50 123-45-67" → "+971501234567"; null unless it is an international number (+, 7–15 digits). */
export function normPhone(v: string): string | null {
  const t = v.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(t) ? t : null;
}

export interface ParseOptions {
  /** Ask for a name (2+ characters). */
  name?: boolean;
  /** Ask for a delivery address (8+ characters), e.g. for physical goods. */
  address?: boolean;
}

/**
 * Checks a contact from a form (any JSON). Needs an email or a phone (with its app); name and address only when
 * asked. Errors are short, plain sentences you can show next to the form.
 */
export function parseContact(raw: unknown, need: ParseOptions = {}): { contact: Contact } | { error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: Contact = {};
  const name = str(r.name, 80), address = str(r.address, 300), emailIn = str(r.email, 200), phoneIn = str(r.phone, 30);
  if (need.name && name.length < 2) return { error: "add your name" };
  if (name) c.name = name;
  if (emailIn) {
    const e = normEmail(emailIn);
    if (!e) return { error: "that email doesn't look right" };
    c.email = e;
  }
  if (phoneIn) {
    const p = normPhone(phoneIn);
    if (!p) return { error: "write the phone number with the country code, like +1 212 555 0100" };
    c.phone = p;
    c.app = isApp(r.app) ? r.app : "sms";
  }
  if (!c.email && !c.phone) return { error: "add an email or a phone number so you can be reached" };
  if (need.address && address.length < 8) return { error: "add the delivery address" };
  if (address) c.address = address;
  return { contact: c };
}

/** Tap-to-open buttons for a contact: the messenger, a call, an email. Only uses a phone that passes normPhone. */
export function contactLinks(c: Contact): ContactLink[] {
  const out: ContactLink[] = [];
  const phone = c.phone ? normPhone(c.phone) : null;
  if (phone) {
    const d = phone.slice(1);
    const app = appOf(c);
    const href = { whatsapp: `https://wa.me/${d}`, telegram: `https://t.me/+${d}`, signal: `https://signal.me/#p/+${d}`, viber: `viber://chat?number=%2B${d}`, imessage: `sms:+${d}`, sms: `sms:+${d}` }[app];
    out.push({ label: app === "sms" ? "Text" : APPS[app], value: phone, href });
    out.push({ label: "Call", value: phone, href: `tel:+${d}` });
  }
  const email = c.email ? normEmail(c.email) : null;
  if (email) out.push({ label: "Email", value: email, href: `mailto:${email}` });
  return out;
}

/** One line for emails and notifications: "WhatsApp +971… · jane@example.com". */
export const contactLine = (c: Contact): string => [c.phone ? `${APPS[appOf(c)]} ${c.phone}` : "", c.email ?? ""].filter(Boolean).join(" · ");
