# ADR 0025 — Orders page, seller refunds before delivery, buyer ↔ store messages

Status: accepted (8 Nov 2026)

## Context
Store items could only be "marked shipped" from a box on Home. A seller couldn't decline a paid order, didn't see a
buyer's refund or revision request, and had no way to talk to the buyer. The orders contract let the seller refund
only after a refund request.

## Decision
- **Contract** (`orders`): `approve_refund` also works while the order is `Held` or `RevisionRequested` (decline the
  order / give up a fix), besides `RefundRequested` and `Disputed`. It only ever pays the buyer back in full, so the
  stores' existing function-call keys (`mark_delivered, approve_refund, decline_refund`) cover it: no key rotation.
  A delivered order is still the buyer's to accept or contest. Sandbox test added; upgraded on testnet 8 Nov (state
  kept; code hash checked against the local build).
- **Seller app**: an Orders page (nav) and one page per order: the status in plain words from the contract (to ship,
  shipped, buyer says it isn't right, refund requested, refund declined, refunded, paid out), the buyer's details,
  where the money is, and the actions for that status (Mark shipped, Decline & refund, Approve / Decline a refund).
  Actions go through the outbox (`item.refund`, `item.refund_decline`) and are signed by the store's orders key.
- **Messages**: `order_messages` (off-chain, instant, text only, 1000 chars, 30 per side per 10 min). The seller
  writes from the order page; the buyer from their order page (the unguessable order id is their access, as for the
  page itself), only once the order is paid. Each side is emailed on a new message when we know an address (the
  seller's linked email; the buyer's if they were signed in when ordering — `orderBuyer:<id>`). Both pages poll every
  4 s while open. Money never moves through messages; both sides are reminded not to pay outside the order.
- Escrow timer: an item order whose buyer asks for a revision goes back to "to ship" (it used to start the deck
  rewrite job), and a refund seen on chain updates the order row.

## Consequences
- Seller-initiated refunds are final and immediate; the UI asks for confirmation.
- No push or Telegram notifications for messages yet (email only).
