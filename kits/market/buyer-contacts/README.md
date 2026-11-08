# Buyer contacts

No in-app chat: the buyer leaves a phone (with the messenger they use) or an email at checkout, the seller taps a button and talks to them in WhatsApp, Telegram, Signal, Viber, iMessage, SMS or email — and the contact disappears 90 days after the order closes.

Building a chat means storage, moderation, notifications, spam and a second inbox nobody checks. Small sellers already
live in their messengers; this kit gives you the three pieces you need instead: check the contact, turn it into
tap-to-open links, and hide it when the seller no longer needs it.

## Copy it

```sh
cp -r kits/market/buyer-contacts ./src/buyer-contacts   # no runtime dependencies
```

```ts
import { parseContact, contactLinks, contactLine, contactVisible } from "./buyer-contacts/src/index.js";
```

## Use it

```ts
// Checkout form (any JSON from the browser)
const r = parseContact(req.body.contact, { address: true });   // physical goods: ask for the address
if ("error" in r) return res.status(400).json({ error: r.error }); // "write the phone number with the country code, …"
await db.saveOrder({ ...order, contact: r.contact });           // { phone: "+971501234567", app: "whatsapp", address: "…" }

// Seller's order page
if (contactVisible(order)) {
  for (const l of contactLinks(order.contact)) html += `<a href="${l.href}">${l.label}</a>`; // WhatsApp · Call · Email
}

// Order notification email
`Contact: ${contactLine(order.contact)}`   // "WhatsApp +971501234567 · jane@example.com"
```

Run `npx tsx example.ts` for a full round trip.

## Options

| Function | Option | Default | What it does |
| --- | --- | --- | --- |
| `parseContact(raw, need)` | `need.name` | `false` | Require a name (2+ characters) |
| | `need.address` | `false` | Require a delivery address (8+ characters) |
| `contactVisible(order, opts)` | `keepMs` | 90 days | How long the contact stays visible after the order closes |
| | `closedStates` | `["released", "refunded"]` | Order states that count as closed (use your own names) |
| | `now` | `Date.now()` | Current time, for tests |

Other exports: `normPhone(s)` (`"+1 (212) 555-0100"` → `"+12125550100"`, `null` without a country code),
`normEmail(s)`, `APPS` (ids → display names), `DAY_MS`.

## How it works

- **Phone**: spaces, dots, dashes and brackets are removed; it must then be `+` and 7–15 digits (E.164). Numbers
  without a country code are refused on purpose: the seller may be in another country, and `wa.me` needs it.
- **App**: one of `whatsapp telegram signal viber imessage sms`; anything else becomes `sms`. Links:

  | app | link |
  | --- | --- |
  | whatsapp | `https://wa.me/<digits>` |
  | telegram | `https://t.me/+<digits>` (opens the chat if the number allows it) |
  | signal | `https://signal.me/#p/+<digits>` |
  | viber | `viber://chat?number=%2B<digits>` |
  | imessage, sms | `sms:+<digits>` |
  | always | `tel:+<digits>` (Call), `mailto:<email>` |

- **Data is data**: `contactLinks` re-checks phone and email before building a link, so a value edited in the database
  can't become a `javascript:` or extra-recipient link. Fields that aren't strings are ignored; long ones are cut.
- **Privacy window**: `contactVisible` is a pure function of the order's state and `updatedAt` (when it last changed
  state). Use it everywhere the contact is shown (page, API, export). It hides; deleting the stored contact after the
  window is your own job (a nightly query with the same rule).

## Tested

57 Vitest tests: phone formats from several countries and the 7/15-digit edges, rejected formats (no `+`, `00`,
extensions, letters), emails, every `parseContact` error, non-object input, length caps, prototype-key app names,
every messenger link, unsafe stored values, `contactLine`, the 90-day edge and custom windows/states.
Not tested: that each messenger app actually opens on every phone OS (links follow their public docs).

## Came from

Nearchant, ADR 0026 (`docs/adr/0026-shop-contacts-no-chat.md`): `apps/gateway/src/contact.ts` (checkout and the
seller's order page), `normEmail` from `apps/gateway/src/email.ts`, and `contactVisible` from
`apps/gateway/src/ui/orders.tsx`.
