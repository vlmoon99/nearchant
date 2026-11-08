// Seller app: Orders and one order — what happened, what to do next, and how to reach the buyer (ADR 0026).
// Money state comes from the orders contract on NEAR (the truth); talking happens in the buyer's own messenger or email.
import type { FC } from "hono/jsx";
import type { Contact } from "../contact.js";
import { ContactList, Icon, PageHead, Segmented, Shell, UiPage, type UiConfig } from "./kit.js";
import type { StoreView } from "./app-pages.js";

export interface SellerOrder {
  orderId: string; title: string; kind: string; amount: string; brief: string; state: string; chainStatus: string | null; createdAt: string; updatedAt: string;
  contact: Contact | null;
}

/** The order in the seller's words: a label, what it means, and whether it waits for the seller. */
/** `busy`: something is being recorded on NEAR right now (the page follows it live). */
export function orderStage(state: string, chain: string | null): { label: string; note: string; tone: "act" | "wait" | "done" | "bad"; busy?: boolean } {
  const s = chain ?? "";
  if (s === "Refunded" || state === "refunded") return { label: "Refunded", note: "The buyer got their money back.", tone: "done" };
  if (s === "Released" || state === "released") return { label: "Paid out", note: "The buyer confirmed. The money is in your wallet.", tone: "done" };
  if (s === "Refunding" || s === "Releasing") return { label: s === "Refunding" ? "Refunding…" : "Paying out…", note: "Recording it on NEAR — a few seconds.", tone: "wait", busy: true };
  if (s === "RefundRequested") return { label: "Refund requested", note: "The buyer asked for their money back. Approve it, or decline and contact them to sort it out.", tone: "act" };
  if (s === "Disputed") return { label: "Refund declined", note: "You declined the refund. Agree with the buyer directly — you can still refund any time.", tone: "bad" };
  if (s === "RevisionRequested") return { label: "Buyer says it isn't right", note: "The buyer asked for a fix. Contact them, ship it again or refund — the delivery window started over.", tone: "act" };
  if (s === "Delivered" || state === "delivered") return { label: "Shipped", note: "Waiting for the buyer to confirm. If they don't, it pays out automatically.", tone: "wait" };
  if (state === "in_progress") return { label: "Marking shipped…", note: "Recording the shipment on NEAR — a few seconds.", tone: "wait", busy: true };
  if (state === "paid" || s === "Held") return { label: "New", note: "Paid and safe in escrow. Contact the buyer if needed, then ship and mark it shipped — or decline and refund.", tone: "act" };
  return { label: state, note: "", tone: "wait" };
}
export const Pill: FC<{ st: ReturnType<typeof orderStage> }> = ({ st }) => <span class={`pill ${st.tone}`}>{st.label}</span>;

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const CLOSED_KEEP_MS = 90 * 86_400_000;
/** Buyer contacts are kept for 90 days after an order closes (ADR 0026). */
export const contactVisible = (o: Pick<SellerOrder, "state" | "updatedAt">, now = Date.now()) => !["released", "refunded"].includes(o.state) || now - new Date(o.updatedAt).getTime() < CLOSED_KEEP_MS;

export const OrdersPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; orders: SellerOrder[]; filter: string }> = ({ cfg, test, store, orders, filter }) => {
  const act = orders.filter((o) => orderStage(o.state, o.chainStatus).tone === "act");
  const open = orders.filter((o) => orderStage(o.state, o.chainStatus).tone !== "done");
  const shown = filter === "done" ? orders.filter((o) => orderStage(o.state, o.chainStatus).tone === "done") : filter === "all" ? orders : open;
  return (
    <UiPage title="Orders · Nearchant" cfg={cfg} page="app" test={test}>
      <Shell active="Orders" store={store}>
        <PageHead kicker={act.length ? `${act.length} need${act.length === 1 ? "s" : ""} you` : "All caught up"} title="Orders" />
        <Segmented items={[{ label: `Open${open.length ? ` (${open.length})` : ""}`, href: "/app/orders", on: filter === "open" }, { label: "Done", href: "/app/orders?f=done", on: filter === "done" }, { label: "All", href: "/app/orders?f=all", on: filter === "all" }]} />
        {!shown.length ? <div class="empty"><Icon n="box" s={40} c="var(--label-2)" /><span class="headline">{orders.length ? "Nothing here" : "No orders yet"}</span><span class="foot muted">When someone buys, the order shows up here with their contact and delivery details. You also get an email if you added one in Settings.</span></div>
          : <div class="list">{shown.map((o) => {
            const st = orderStage(o.state, o.chainStatus);
            return <a class="list-row nav" href={`/app/orders/${o.orderId}`} data-order-row={o.orderId}>
              <span class="list-text"><span class="body b clamp1">{o.title}</span><span class="foot muted clamp1">{o.contact?.name ? `${o.contact.name} · ` : ""}{when(o.createdAt)}</span></span>
              <span class="stack" style="gap:4px;align-items:flex-end"><span class="sub b">{o.amount}</span><Pill st={st} /></span>
              <Icon n="chevron" s={16} c="var(--label-3)" /></a>;
          })}</div>}
        {orders.some((o) => orderStage(o.state, o.chainStatus).busy) ? <span class="live" data-refresh="4000"><span class="spin"></span>Recording on NEAR — this list updates by itself</span> : null}
        <span class="cap muted">Buyers pay into escrow on NEAR. You're paid when they confirm — or automatically after the release time.</span>
      </Shell>
    </UiPage>
  );
};

export const SellerOrderPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; o: SellerOrder; explorer: string }> = ({ cfg, test, store, o, explorer }) => {
  const st = orderStage(o.state, o.chainStatus);
  const s = o.chainStatus ?? "";
  const canShip = o.state === "paid" && (s === "Held" || s === "RevisionRequested" || !s);
  const canRefund = ["Held", "RevisionRequested", "RefundRequested", "Disputed"].includes(s);
  const service = o.kind === "service";
  const showContact = o.contact && contactVisible(o);
  return (
    <UiPage title="Order · Nearchant" cfg={cfg} page="app" test={test}>
      <Shell active="Orders" store={store}>
        <a class="back" href="/app/orders"><Icon n="chevron" s={18} />Orders</a>
        <PageHead kicker={`${o.amount} · ${when(o.createdAt)}`} title={o.title} />
        <div class="cols post-cols">
          <div class="stack" style="gap:24px">
            <section class="group"><span class="group-h">Status</span>
              <div class="card white" style="gap:10px" data-live-order={o.orderId} data-title={o.title} data-label={st.label} data-busy={st.busy ? "1" : "0"}><div class="spread"><span class="headline">{st.label}</span><Pill st={st} /></div><span class="sub muted">{st.note}</span>
                <div class={`live ${st.busy ? "" : "hidden"}`} data-live aria-live="polite"><span class="spin"></span><span data-live-text>{st.busy ? "Checking NEAR…" : ""}</span></div>
                {canShip ? <div class="stack" style="gap:10px"><input class="input" data-ship-note={o.orderId} placeholder={service ? "A note for the buyer (optional)" : "Tracking number or a note (optional)"} />
                  <button class="btn block" data-ship={o.orderId} data-act><Icon n="send" />{service ? "Mark done" : "Mark shipped"}</button></div> : null}
                {s === "RefundRequested" ? <div class="row" style="gap:10px"><button class="btn" style="flex:1" data-act data-order-refund={o.orderId} data-confirm="Give the buyer their money back?|The full amount goes back to the buyer from escrow. This can't be undone.|Refund">Approve refund</button>
                  <button class="btn secondary" style="flex:1" data-act data-order-decline-refund={o.orderId} data-confirm="Decline the refund?|Then contact the buyer and explain why. You can still refund later.|Decline">Decline</button></div>
                  : canRefund ? <button class="btn plain danger" data-act data-order-refund={o.orderId} data-confirm={canShip ? "Decline this order?|The buyer gets the full amount back from escrow. This can't be undone.|Decline & refund" : "Refund the buyer?|The full amount goes back from escrow. This can't be undone.|Refund"}>{canShip ? "Decline & refund" : "Refund the buyer"}</button> : null}
                </div></section>
            <section class="group"><span class="group-h">Buyer</span>
              {showContact ? <>
                <div class="list">{o.contact!.name ? <div class="list-row"><span class="list-text"><span class="cap muted">Name</span><span class="body">{o.contact!.name}</span></span></div> : null}
                  {o.contact!.address ? <div class="list-row"><span class="list-text"><span class="cap muted">Deliver to</span><span class="body" style="white-space:pre-wrap">{o.contact!.address}</span></span><button class="icon-btn" type="button" data-copy={o.contact!.address} aria-label="Copy address"><Icon n="copy" s={18} /></button></div> : null}</div>
                <ContactList c={o.contact!} />
                <span class="group-f">Only you see this. It is hidden 90 days after the order closes.</span></>
                : <div class="list"><div class="list-row"><span class="foot muted">{o.contact ? "Hidden — this order closed more than 90 days ago." : "This buyer ordered before contact details were asked. Their note is below."}</span></div></div>}
            </section>
            <section class="group"><span class="group-h">{service ? "Their request" : "Their note"}</span>
              <div class="list"><div class="list-row"><span class="body" style="white-space:pre-wrap">{o.brief || "—"}</span></div></div></section>
          </div>
          <section class="group"><span class="group-h">Money</span>
            <div class="card white" style="gap:8px"><span class="foot muted">{st.label === "Refunded" ? `${o.amount} went back to the buyer from the orders contract on NEAR.`
                : st.label === "Paid out" ? `${o.amount} was paid from the orders contract on NEAR to your store account.`
                : `${o.amount} is held by the orders contract on NEAR — not by Nearchant, not by the buyer. It goes to you when the buyer confirms (or after the release time), or back to the buyer on a refund.`}</span>
              <a class="foot" href={explorer} target="_blank" rel="noopener"><Icon n="globe" s={13} /> The escrow contract on NEAR explorer</a></div>
            <span class="group-f">Never ask the buyer to pay outside the order — escrow protects you both.</span></section>
        </div>
      </Shell>
    </UiPage>
  );
};
