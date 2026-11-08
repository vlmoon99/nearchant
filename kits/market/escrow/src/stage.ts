import type { OrderStatus } from "./types.js";

export type Role = "seller" | "buyer";
export interface Stage {
  label: string;
  note: string;
  /** act = this person needs to do something · wait = someone else / time · done = closed · bad = needs talking */
  tone: "act" | "wait" | "done" | "bad";
  /** A chain transaction is in flight: show a spinner and refresh in a few seconds. */
  busy?: boolean;
}

/** Turns an escrow status into words for an order list or page, for the seller (default) or the buyer. */
export function orderStage(status: OrderStatus | string | null | undefined, role: Role = "seller"): Stage {
  const seller = role === "seller";
  switch (status) {
    case "Opening":
      return { label: "Opening…", note: "Checking the seller on NEAR — a few seconds.", tone: "wait", busy: true };
    case "Held":
      return seller
        ? { label: "New", note: "Paid and safe in escrow. Contact the buyer if needed, then deliver and mark it delivered — or decline and refund.", tone: "act" }
        : { label: "Paid", note: "Your money is safe in escrow until you confirm delivery. If the seller doesn't deliver in time, you get it back.", tone: "wait" };
    case "Delivered":
      return seller
        ? { label: "Delivered", note: "Waiting for the buyer to confirm. If they don't, it pays out automatically.", tone: "wait" }
        : { label: "Delivered", note: "Check it, then confirm to pay the seller — or ask for a fix. If you do nothing, it pays out automatically.", tone: "act" };
    case "RevisionRequested":
      return seller
        ? { label: "Buyer says it isn't right", note: "The buyer asked for a fix. Contact them, deliver again or refund — the delivery window started over.", tone: "act" }
        : { label: "Fix requested", note: "The seller has a new delivery window. If they don't deliver in time, you get your money back.", tone: "wait" };
    case "RefundRequested":
      return seller
        ? { label: "Refund requested", note: "The buyer asked for their money back. Approve it, or decline and contact them to sort it out.", tone: "act" }
        : { label: "Refund requested", note: "Waiting for the seller to approve your refund.", tone: "wait" };
    case "Disputed":
      return seller
        ? { label: "Refund declined", note: "You declined the refund. Agree with the buyer directly — you can still refund any time.", tone: "bad" }
        : { label: "Refund declined", note: "The seller declined your refund. Contact them to sort it out; the money stays in escrow.", tone: "bad" };
    case "Releasing":
      return { label: "Paying out…", note: "Recording it on NEAR — a few seconds.", tone: "wait", busy: true };
    case "Refunding":
      return { label: "Refunding…", note: "Recording it on NEAR — a few seconds.", tone: "wait", busy: true };
    case "Released":
      return seller
        ? { label: "Paid out", note: "The buyer confirmed. The money is in your wallet.", tone: "done" }
        : { label: "Completed", note: "The seller has been paid.", tone: "done" };
    case "Refunded":
      return seller
        ? { label: "Refunded", note: "The buyer got their money back.", tone: "done" }
        : { label: "Refunded", note: "Your money is back in your wallet.", tone: "done" };
    default:
      return { label: status ? String(status) : "Unknown", note: "", tone: "wait" };
  }
}
