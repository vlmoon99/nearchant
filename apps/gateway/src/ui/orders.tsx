// Seller app: Orders and one order — what happened, what to do next, and messages with the buyer.
// Money state comes from the orders contract on NEAR (the truth); messages are off-chain and instant.
import type { FC } from "hono/jsx";
import type { OrderMessage } from "@nearchant/db";
import { Icon, PageHead, Shell, UiPage, type UiConfig } from "./kit.js";
import type { StoreView } from "./app-pages.js";

export interface SellerOrder {
  orderId: string; title: string; amount: string; brief: string; state: string; chainStatus: string | null; createdAt: string;
  unread: number; last?: { author: string; text: string } | null;
}

/** The order in the seller's words: a label, what it means, and whether it waits for the seller. */
export function orderStage(state: string, chain: string | null): { label: string; note: string; tone: "act" | "wait" | "done" | "bad" } {
  const s = chain ?? "";
  if (s === "Refunded" || state === "refunded") return { label: "Refunded", note: "The buyer got their money back.", tone: "done" };
  if (s === "Released" || state === "released") return { label: "Paid out", note: "The buyer confirmed. The money is in your wallet.", tone: "done" };
  if (s === "Refunding" || s === "Releasing") return { label: s === "Refunding" ? "Refunding…" : "Paying out…", note: "Recording it on NEAR — a few seconds.", tone: "wait" };
  if (s === "RefundRequested") return { label: "Refund requested", note: "The buyer asked for their money back. Approve it, or decline and talk it through.", tone: "act" };
  if (s === "Disputed") return { label: "Refund declined", note: "You declined the refund. Agree with the buyer in messages — you can still refund any time.", tone: "bad" };
  if (s === "RevisionRequested") return { label: "Buyer says it isn't right", note: "The buyer asked for a fix. Ship it again (or refund) — the delivery window started over.", tone: "act" };
  if (s === "Delivered" || state === "delivered") return { label: "Shipped", note: "Waiting for the buyer to confirm. If they don't, it pays out automatically.", tone: "wait" };
  if (state === "in_progress") return { label: "Marking shipped…", note: "Recording the shipment on NEAR — a few seconds.", tone: "wait" };
  if (state === "paid" || s === "Held") return { label: "New — to ship", note: "Paid and safe in escrow. Ship it and mark it shipped, or decline and refund.", tone: "act" };
  return { label: state, note: "", tone: "wait" };
}
const TONE = { act: "background:#e6f0ff;color:#0a56c2", wait: "background:var(--bg-2);color:var(--label2)", done: "background:#e3faf0;color:#007a4f", bad: "background:#fff3c4;color:#8a5a00" } as const;
const Chip: FC<{ st: ReturnType<typeof orderStage> }> = ({ st }) => <span class="cap b" style={`${TONE[st.tone]};padding:3px 8px;border-radius:999px;white-space:nowrap`}>{st.label}</span>;

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const OrdersPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; orders: SellerOrder[] }> = ({ cfg, test, store, orders }) => {
  const act = orders.filter((o) => orderStage(o.state, o.chainStatus).tone === "act" || o.unread);
  return (
    <UiPage title="Orders · Nearchant" cfg={cfg} page="app" test={test}>
      <Shell active="Orders" store={store}>
        <PageHead kicker={act.length ? `${act.length} need${act.length === 1 ? "s" : ""} you` : "All caught up"} title="Orders" />
        {!orders.length ? <div class="card"><span class="headline">No orders yet</span><span class="foot muted">When someone buys, the order shows up here with their delivery details and a chat with them. You get an email too, if you linked one in Settings.</span></div>
          : <div class="stack s12">{orders.map((o) => {
            const st = orderStage(o.state, o.chainStatus);
            return <a class="card white" href={`/app/orders/${o.orderId}`} style="color:inherit;gap:6px">
              <div class="spread"><span class="callout b">{o.title}</span><span class="sub b">{o.amount}</span></div>
              <div class="spread" style="gap:8px"><Chip st={st} /><span class="cap muted">{when(o.createdAt)}</span></div>
              {o.last ? <span class="foot muted clamp1">{o.last.author === "buyer" ? "Buyer" : "You"}: {o.last.text}</span> : <span class="foot muted clamp1">{o.brief}</span>}
              {o.unread ? <span class="cap b" style="color:#0a56c2"><Icon n="msg" s={13} /> {o.unread} new message{o.unread > 1 ? "s" : ""}</span> : null}
            </a>;
          })}</div>}
        <span class="cap muted">Buyers pay into escrow on NEAR. You're paid when they confirm — or automatically after the release time. Messages are private between you and the buyer.</span>
      </Shell>
    </UiPage>
  );
};

export const SellerOrderPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; o: SellerOrder; messages: OrderMessage[]; explorer: string }> = ({ cfg, test, store, o, messages, explorer }) => {
  const st = orderStage(o.state, o.chainStatus);
  const s = o.chainStatus ?? "";
  const canShip = o.state === "paid" && (s === "Held" || s === "RevisionRequested" || !s);
  const canRefund = ["Held", "RevisionRequested", "RefundRequested", "Disputed"].includes(s);
  return (
    <UiPage title="Order · Nearchant" cfg={cfg} page="app" test={test}>
      <Shell active="Orders" store={store}>
        <a class="sub" href="/app/orders">‹ Orders</a>
        <PageHead kicker={`${o.amount} · ${when(o.createdAt)}`} title={o.title} />
        <div class="cols post-cols">
          <div class="stack s12">
            <div class="card" style="gap:8px"><div class="spread"><span class="headline">Status</span><Chip st={st} /></div><span class="sub">{st.note}</span>
              {canShip ? <div class="stack" style="gap:8px"><input class="input" data-ship-note={o.orderId} placeholder="Tracking number or a note for the buyer (optional)" />
                <button class="btn" data-ship={o.orderId}><Icon n="send" />Mark shipped</button></div> : null}
              {s === "RefundRequested" ? <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" data-order-refund={o.orderId} data-confirm="Give the buyer their money back?">Approve refund</button>
                <button class="btn secondary" data-order-decline-refund={o.orderId} data-confirm="Decline the refund? Explain why in a message to the buyer.">Decline</button></div>
                : canRefund ? <button class="btn secondary" data-order-refund={o.orderId} data-confirm={canShip ? "Decline this order and refund the buyer in full? This can't be undone." : "Refund the buyer in full? This can't be undone."}>{canShip ? "Decline & refund" : "Refund the buyer"}</button> : null}
              <output class="foot" data-order-out></output>
            </div>
            <div class="card" style="gap:6px"><span class="headline">What the buyer wrote</span><span class="sub" style="white-space:pre-wrap">{o.brief || "—"}</span></div>
            <div class="card" style="gap:6px"><span class="headline">Money</span>
              <span class="foot muted">{st.label === "Refunded" ? `${o.amount} went back to the buyer from the orders contract on NEAR.`
                : st.label === "Paid out" ? `${o.amount} was paid from the orders contract on NEAR to your store account.`
                : `${o.amount} is held by the orders contract on NEAR — not by Nearchant, not by the buyer. It goes to you when the buyer confirms (or after the release time), or back to the buyer on a refund.`}</span>
              <a class="foot" href={explorer} target="_blank" rel="noopener"><Icon n="globe" s={13} /> The escrow contract on NEAR explorer</a></div>
          </div>
          <div class="card chat" data-chat={`/api/app/orders/${o.orderId}/messages`} data-me="seller" style="gap:10px">
            <span class="headline">Messages with the buyer</span>
            <div class="stack chat-log" style="gap:8px;max-height:420px;overflow:auto">
              {messages.length ? messages.map((m) => <div class={`bubble ${m.author === "seller" ? "me" : ""}`}><span>{m.text}</span><span class="cap muted">{when(m.at)}</span></div>)
                : <span class="foot muted chat-empty">No messages yet. Say hi, confirm the details or share the tracking number — the buyer gets an email if they signed in.</span>}
            </div>
            <form class="row chat-form" style="gap:8px"><input class="input" name="text" maxlength={1000} placeholder="Write to the buyer…" autocomplete="off" style="flex:1" /><button class="btn" type="submit"><Icon n="send" /></button></form>
            <span class="cap muted">Never ask for payment outside the order — the escrow protects you both.</span>
          </div>
        </div>
      </Shell>
    </UiPage>
  );
};
