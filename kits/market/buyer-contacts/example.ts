// npx tsx example.ts   — a checkout form → stored contact → the seller's buttons → hidden 90 days after closing.
import { contactLine, contactLinks, contactVisible, parseContact } from "./src/index.js";

const form = { name: " Jane  Doe ", phone: "+971 50 123-45-67", app: "whatsapp", email: "Jane@Example.com", address: "Villa 12, Palm Jumeirah, Dubai" };
const parsed = parseContact(form, { name: true, address: true });
if ("error" in parsed) throw new Error(parsed.error);
console.log("stored:", parsed.contact);
console.log("seller sees buttons:");
for (const l of contactLinks(parsed.contact)) console.log(`  ${l.label.padEnd(9)} ${l.href}`);
console.log("in the order email:", contactLine(parsed.contact));
console.log("bad phone →", parseContact({ phone: "050 123 4567" }));
const closed = { state: "released", updatedAt: "2026-07-01T00:00:00Z" };
console.log("closed on 1 Jul, visible on 8 Nov?", contactVisible(closed, { now: Date.parse("2026-11-08") }));
