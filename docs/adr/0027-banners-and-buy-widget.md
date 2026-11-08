# ADR 0027: Banners and a buy widget: sell an item from any social network or website

Status: accepted (8 Nov 2026)

## Context
- The owner wants to show their products and services outside Nearchant:
  - as images for their own social posts (Instagram, Facebook, TikTok, X, LinkedIn, Telegram);
  - as banners on websites;
  - as a buy widget embedded in a website.
- Card, Apple Pay and Google Pay come later.
- The embed widget was cut from M0 (`docs/m0-scope.md`); the owner now asks for it.

## Decision
- **Banners** (`src/banners.ts`): built with sharp from the item photo (SVG text over it, the Inter font in the image). Five formats:
  - square 1080×1080;
  - story 1080×1920;
  - wide 1200×630;
  - website ad 300×250 (made at 2×);
  - website banner 728×90 (made at 2×).
- Each banner carries the name, price (with "From" for a "from" price), the store, a "Buy now" or "Book now" button and a QR code (except the two small website sizes). The QR opens the item with `?ref=banner`, so analytics count it.
- They are public at `/h/<store>/banner/<item>/<format>.png` (`?download=1` saves the file). They are cached in the store's public media by a hash of what they show, so a change of text, price or photo makes a new file.
- No banner is made for an item that is hidden, held by the safety check, or in a paused store.
- **Buy widget:** `/h/<store>/embed/i/<item>` shows one card; `/h/<store>/embed` shows every live item.
  - Its Buy button opens the item on Nearchant in a **new tab**; nothing is paid inside the frame. So any site may frame it (`frame-ancestors *`, no `X-Frame-Options`), while every other page keeps `frame-ancestors 'none'`.
  - `nearchant.com/embed.js` turns `<script data-nearchant-store … data-nearchant-item …>` into the iframe and sizes it from a `postMessage` sent by `/assets/embed-frame.js`. The message is accepted only from Nearchant's origin and only from that frame.
  - The widget follows the visitor's light or dark setting.
  - A widget view counts as a store view with source `widget`.
- **Seller app:**
  - Shop → Share: the store link, the shop widget code, and links to each item's page.
  - Item → "Banners, link & buy widget": the link, 5 banner previews with Save, the script and iframe code, a live preview.
  - Both pages show "How buyers pay": nUSD on NEAR (live) and card / Apple Pay / Google Pay (coming).
- **Card, Apple Pay and Google Pay are not built here.** Plan: a card on-ramp pays nUSD into the same escrow, so stores keep the same flow. That needs a provider (KYC, fees) and mainnet; it comes after the hackathon.

## Consequences
- Banners don't change existing data. Re-rendering after an edit happens on the next request, and the old files stay until media cleanup.
- Paying in a new tab means the buyer leaves the host site to pay. That is the price of not letting other sites frame the payment.
