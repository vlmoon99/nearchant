import { createHash } from "node:crypto";
// What a store sells (ADR 0026): the extra fields of a product or a service, kept in items.details.
export type Stock = "in_stock" | "made_to_order" | "sold_out";
export type Shipping = "world" | "countries" | "pickup";
export type Mode = "online" | "seller" | "buyer";

export interface ItemDetails {
  // product
  stock?: Stock; shipping?: Shipping; countries?: string; optionName?: string;
  // service
  deliveryDays?: number; mode?: Mode; question?: string; priceFrom?: boolean;
}

const pick = <T extends string>(v: unknown, all: readonly T[], dflt: T): T => (all.includes(v as T) ? (v as T) : dflt);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** Cleans the details a seller sent for a product or a service (unknown fields are dropped). */
export function parseDetails(kind: string, raw: unknown): ItemDetails {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (kind === "service") {
    const days = Math.round(Number(r.deliveryDays));
    const d: ItemDetails = { mode: pick(r.mode, ["online", "seller", "buyer"] as const, "online"), deliveryDays: days >= 1 && days <= 365 ? days : 7, priceFrom: r.priceFrom === true };
    const q = str(r.question, 200);
    if (q) d.question = q;
    return d;
  }
  const d: ItemDetails = { stock: pick(r.stock, ["in_stock", "made_to_order", "sold_out"] as const, "in_stock"), shipping: pick(r.shipping, ["world", "countries", "pickup"] as const, "world") };
  const countries = str(r.countries, 120), optionName = str(r.optionName, 30);
  if (d.shipping === "countries" && countries) d.countries = countries;
  if (optionName) d.optionName = optionName;
  return d;
}

export const STOCK: Record<Stock, string> = { in_stock: "In stock", made_to_order: "Made to order", sold_out: "Sold out" };
export const MODE: Record<Mode, string> = { online: "Online", seller: "At the store", buyer: "At your place" };

/** Does the buyer give a delivery address? (products that are not pickup-only) */
export const ships = (kind: string, d: ItemDetails) => kind !== "service" && d.shipping !== "pickup";
export const soldOut = (kind: string, d: ItemDetails) => kind !== "service" && d.stock === "sold_out";

/** Short facts under the price: "In stock · Ships worldwide", "Online · Ready in 3 days". */
export function itemFacts(kind: string, d: ItemDetails): string[] {
  if (kind === "service") return [MODE[d.mode ?? "online"], `Ready in ${d.deliveryDays ?? 7} day${(d.deliveryDays ?? 7) === 1 ? "" : "s"}`];
  return [STOCK[d.stock ?? "in_stock"], d.shipping === "pickup" ? "Pickup only" : d.shipping === "countries" ? `Ships to ${d.countries || "selected countries"}` : "Ships worldwide"];
}

/** Fingerprint of what the safety check reads (title, description, photo) — the worker keeps its verdict under it. */
export const checkHash = (i: { title: string; description: string; photoMediaId: string | null }) => createHash("sha256").update(`${i.title}\n${i.description}\n${i.photoMediaId ?? ""}`).digest("hex");
