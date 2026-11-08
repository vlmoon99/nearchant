# ADR 0026: Shop (products & services), contact details instead of in-app chat, Apple HIG layer

Status: accepted (8 Nov 2026). Replaces the messages part of ADR 0025.

## Context
- A seller had no way to add what they sell. The only way in was a "Sell" button on items the AI spotted in their photos. It always made a product, never a service, and there was no edit, hide or delete.
- The AI moderator silently switched items off and counted a violation, even for our own false positives.
- ADR 0025 added a chat between buyer and store. The owner does not want chat inside Nearchant:
  - there are no buyer accounts to hold it;
  - sellers already talk to buyers in WhatsApp, Telegram and email.
- The owner asked for the seller app to follow Apple's Human Interface Guidelines.

## Decision (all answers from a grilling round with the owner)
- **Shop page** (`/app/shop`, in the sidebar and in the phone's bottom bar):
  - Products and Services sit in a segmented control. Each is a grouped list with a status pill: Live / Hidden / Needs a change / Sold out.
  - AI suggestions from the photos appear as a "Suggested" section.
  - One edit screen (`/app/shop/new`, `/app/shop/:id`) covers both kinds.
- **Item fields** live in a new `items.details` jsonb, cleaned by `parseDetails`:
  - **Products:** stock (in stock / made to order / sold out), shipping (worldwide / some countries / pickup only), and options as labels with an option name. There is no price per option and no stock count.
  - **Services:** delivery days, where it's done (online / at the store / at the buyer's), one question shown at checkout, and an optional "from" price. With a "from" price the buyer pays the price now, and any extra is agreed outside the app through the contacts.
- **Hide, not delete.** `active=false` hides an item from the store, and past orders keep working. Editing a hidden item keeps it hidden.
- **Safety check on items:**
  - A flagged item gets `items.held = reason`. It stays out of the store and shows "Needs a small change" with **Fix with AI** (`fix_item`: the caption editor rewrites the description, then the check runs again).
  - No violation is recorded and no email is sent. The verdict is kept per text, so saving the same text again keeps it held.
  - `listItems(activeOnly)` returns only items that are both switched on and not held.
- **No chat.**
  - The chat routes, UI and emails are removed. The `order_messages` table stays unused, which needs no migration.
  - **The buyer gives a contact at checkout**, stored in `orders.contact`:
    - a name;
    - an email **or** a phone in international format plus an app (WhatsApp, Telegram, Signal, Viber, iMessage, SMS);
    - an address when the item ships.
  - The seller's order page shows the contact as tap-to-open rows (`wa.me`, `t.me/+…`, `tel:`, `mailto:`) with copy buttons.
  - The contact is hidden 90 days after the order closes. It is hidden when the page is shown; nothing is deleted yet.
- **The store's contact** (`contactOf:<handle>` setting: email or phone + app):
  - It is required in onboarding and editable in Settings.
  - The buyer sees it on their order page only **after paying**. Before payment, all talk stays on the store page, which keeps the "no ordering outside the store" rule.
- **No buyer accounts.**
  - The order page link is the buyer's receipt.
  - If the buyer gave an email, they get the link by email when the payment is confirmed on chain.
  - The store's new-order email carries the buyer's contact and address.
- **NEAR AI Agent Market:** the setup moves into Settings (token → webhook URL + secret, shown once), still manual. Listing services on the market automatically comes after the hackathon.
- **AI posts and opportunities** also know the items added in Shop, services included (`withShopItems`).
- **Apple HIG layer** (`ui.css` after the Figma tokens):
  - system font;
  - inset grouped lists with 44-pt rows;
  - segmented controls;
  - status pills;
  - iOS switches;
  - sheets for confirmations, replacing `confirm()` and `alert()`;
  - 44-pt tap targets;
  - system colours with **dark mode**.

  Brand colours and the logo stay from Figma. Bottom bar: Home, Posts, Create, Shop, Orders. On phones, Wallet and Analytics are reached from Settings, through the gear in the top bar.

## Consequences
- Checkout of a store item needs `itemForSale`: hidden, held and sold-out items can't be bought (409), even if a services mirror row is still active. Deck orders (the M0 card) are unchanged.
- An order placed before this change has no `contact`. Its page says so and shows the note.
- Truly illegal items are held, not counted. They still appear in the moderation log (`item.hold`), so a human moderator can act.
