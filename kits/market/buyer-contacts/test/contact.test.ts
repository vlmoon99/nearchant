import { describe, expect, it } from "vitest";
import { APPS, contactLine, contactLinks, normEmail, normPhone, parseContact, type Contact } from "../src/index.js";

describe("normPhone", () => {
  it.each([
    ["+971 50 123-45-67", "+971501234567"],
    ["+1 (212) 555-0100", "+12125550100"],
    ["  +44 20 7946 0958 ", "+442079460958"],
    ["+7.916.123.45.67", "+79161234567"],
    ["+4915112345678", "+4915112345678"],
    ["+1234567", "+1234567"], // 7 digits: shortest allowed
    ["+123456789012345", "+123456789012345"], // 15 digits: longest allowed (E.164)
  ])("%s → %s", (input, want) => expect(normPhone(input)).toBe(want));

  it.each([
    ["no country code", "050 123 4567"],
    ["00 prefix instead of +", "00971501234567"],
    ["leading zero after +", "+0501234567"],
    ["too short", "+123456"],
    ["too long", "+1234567890123456"],
    ["letters", "+1 212 CALL NOW"],
    ["extension", "+12125550100 ext 5"],
    ["empty", ""],
    ["just a plus", "+"],
    ["slashes", "+1/212/5550100"],
  ])("rejects %s", (_why, input) => expect(normPhone(input)).toBeNull());
});

describe("normEmail", () => {
  it("lowercases and trims", () => expect(normEmail("  Jane.Doe+shop@Example.CO.uk ")).toBe("jane.doe+shop@example.co.uk"));
  it.each(["jane", "jane@", "@example.com", "jane@example", "jane doe@example.com", "<jane@example.com>", "a,b@example.com", "jane@exa_mple.com", `${"a".repeat(250)}@example.com`])(
    "rejects %s", (e) => expect(normEmail(e)).toBeNull());
});

describe("parseContact", () => {
  it("accepts an email only", () => expect(parseContact({ email: "Jane@Example.com" })).toEqual({ contact: { email: "jane@example.com" } }));

  it("accepts a phone with its app, normalised", () =>
    expect(parseContact({ phone: "+971 50 123 45 67", app: "whatsapp" })).toEqual({ contact: { phone: "+971501234567", app: "whatsapp" } }));

  it("defaults an unknown or missing app to sms", () => {
    expect(parseContact({ phone: "+12125550100", app: "myspace" })).toEqual({ contact: { phone: "+12125550100", app: "sms" } });
    expect(parseContact({ phone: "+12125550100" })).toEqual({ contact: { phone: "+12125550100", app: "sms" } });
    expect(parseContact({ phone: "+12125550100", app: "toString" })).toEqual({ contact: { phone: "+12125550100", app: "sms" } }); // not a prototype key
  });

  it("keeps both, plus name and address, trimmed and collapsed", () => {
    const r = parseContact({ name: "  Jane   Doe ", email: "jane@example.com", phone: "+44 20 7946 0958", app: "telegram", address: " 1 High St,\n London " });
    expect(r).toEqual({ contact: { name: "Jane Doe", email: "jane@example.com", phone: "+442079460958", app: "telegram", address: "1 High St, London" } });
  });

  it("needs an email or a phone", () => {
    expect(parseContact({ name: "Jane" })).toEqual({ error: "add an email or a phone number so you can be reached" });
    expect(parseContact({ email: "   ", phone: "" })).toHaveProperty("error");
  });

  it("explains a bad email or phone", () => {
    expect(parseContact({ email: "jane@" })).toEqual({ error: "that email doesn't look right" });
    expect(parseContact({ phone: "050 123 4567" })).toEqual({ error: "write the phone number with the country code, like +1 212 555 0100" });
    // a good email does not excuse a bad phone: the buyer would think the seller can message them
    expect(parseContact({ email: "jane@example.com", phone: "12345" })).toHaveProperty("error");
  });

  it("asks for a name and an address only when told to", () => {
    expect(parseContact({ email: "j@example.com" }, { name: true })).toEqual({ error: "add your name" });
    expect(parseContact({ email: "j@example.com", name: "J" }, { name: true })).toEqual({ error: "add your name" });
    expect(parseContact({ email: "j@example.com" }, { address: true })).toEqual({ error: "add the delivery address" });
    expect(parseContact({ email: "j@example.com", address: "short" }, { address: true })).toEqual({ error: "add the delivery address" });
    expect(parseContact({ email: "j@example.com", name: "Jo", address: "12 Long Road" }, { name: true, address: true })).toHaveProperty("contact");
  });

  it.each([null, undefined, 42, "jane@example.com", [], true])("treats %s as an empty form", (raw) =>
    expect(parseContact(raw)).toEqual({ error: "add an email or a phone number so you can be reached" }));

  it("ignores non-string fields and cuts long ones", () => {
    expect(parseContact({ email: 123, phone: { n: 1 } })).toHaveProperty("error");
    const r = parseContact({ email: "j@example.com", name: "x".repeat(500), address: "y".repeat(1000) });
    if (!("contact" in r)) throw new Error("expected a contact");
    expect(r.contact.name).toHaveLength(80);
    expect(r.contact.address).toHaveLength(300);
  });
});

describe("contactLinks", () => {
  const phone = "+971501234567";
  it.each([
    ["whatsapp", "WhatsApp", "https://wa.me/971501234567"],
    ["telegram", "Telegram", "https://t.me/+971501234567"],
    ["signal", "Signal", "https://signal.me/#p/+971501234567"],
    ["viber", "Viber", "viber://chat?number=%2B971501234567"],
    ["imessage", "iMessage", "sms:+971501234567"],
    ["sms", "Text", "sms:+971501234567"],
  ] as const)("%s → %s link plus a call", (app, label, href) => {
    expect(contactLinks({ phone, app })).toEqual([{ label, value: phone, href }, { label: "Call", value: phone, href: "tel:+971501234567" }]);
  });

  it("adds mailto for an email, after the phone", () => {
    expect(contactLinks({ phone, app: "whatsapp", email: "jane@example.com" }).map((l) => l.href)).toEqual(["https://wa.me/971501234567", "tel:+971501234567", "mailto:jane@example.com"]);
    expect(contactLinks({ email: "jane@example.com" })).toEqual([{ label: "Email", value: "jane@example.com", href: "mailto:jane@example.com" }]);
  });

  it("falls back to sms for an unknown stored app", () => {
    const stored = JSON.parse(`{"phone":"${phone}","app":"icq"}`) as Contact;
    expect(contactLinks(stored)[0]).toEqual({ label: "Text", value: phone, href: "sms:+971501234567" });
  });

  it("makes no link from a value that was never checked (e.g. edited in the database)", () => {
    expect(contactLinks({ phone: "+1 javascript:alert(1)", email: "x@y.com?bcc=all@corp.com" })).toEqual([]);
    expect(contactLinks({})).toEqual([]);
  });
});

describe("contactLine", () => {
  it("joins messenger + phone and email", () => {
    expect(contactLine({ phone: "+971501234567", app: "whatsapp", email: "jane@example.com" })).toBe("WhatsApp +971501234567 · jane@example.com");
    expect(contactLine({ phone: "+12125550100" })).toBe("SMS / call +12125550100");
    expect(contactLine({ email: "jane@example.com" })).toBe("jane@example.com");
    expect(contactLine({})).toBe("");
  });
  it("has a name for every app", () => expect(Object.keys(APPS)).toEqual(["whatsapp", "telegram", "signal", "viber", "imessage", "sms"]));
});
