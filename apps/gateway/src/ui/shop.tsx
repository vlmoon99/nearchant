// Seller app: Shop — the products and services a store sells (ADR 0026). A grouped list per kind, AI suggestions from
// the owner's photos, and one edit screen for adding or changing an item. Client logic: web/app.ts (#item-form).
import type { FC } from "hono/jsx";
import { Icon, PageHead, Segmented, Shell, UiPage, type UiConfig } from "./kit.js";
import type { StoreView } from "./app-pages.js";
import { itemFacts, soldOut, type ItemDetails } from "../item-details.js";

export interface ShopItem { id: string; kind: string; title: string; description: string; price: string; priceNumber: number; img: string | null; active: boolean; held: string | null; options: string[]; details: ItemDetails; photoMediaId: string | null }
export interface Suggestion { title: string; description: string; photoMediaId: string | null; img: string | null }
export interface PhotoPick { id: string; img: string }

const status = (i: ShopItem): { label: string; tone: string } =>
  i.held ? { label: "Needs a change", tone: "bad" } : !i.active ? { label: "Hidden", tone: "wait" } : soldOut(i.kind, i.details) ? { label: "Sold out", tone: "wait" } : { label: "Live", tone: "done" };

const Thumb: FC<{ img: string | null; kind: string }> = ({ img, kind }) => (
  <span class="thumb" style={img ? `background-image:url('${img}')` : ""}>{img ? null : <Icon n={kind === "service" ? "users" : "bag"} s={22} c="#8e8e93" />}</span>
);

export const ShopPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; items: ShopItem[]; suggestions: Suggestion[]; tab: "product" | "service" }> = ({ cfg, test, store, items, suggestions, tab }) => {
  const list = items.filter((i) => i.kind === tab);
  const held = items.filter((i) => i.held).length;
  const noun = tab === "service" ? "service" : "product";
  return (
    <UiPage title="Shop · Nearchant" cfg={cfg} page="app" test={test}>
      <Shell active="Shop" store={store}>
        <PageHead kicker={held ? `${held} need${held === 1 ? "s" : ""} a small change` : `${items.filter((i) => i.active && !i.held).length} live in your store`} title="Shop">
          <a class="btn" href={`/app/shop/new?kind=${tab}`}><Icon n="plus" />Add {noun}</a>
        </PageHead>
        <Segmented items={[{ label: `Products (${items.filter((i) => i.kind === "product").length})`, href: "/app/shop?k=product", on: tab === "product" }, { label: `Services (${items.filter((i) => i.kind === "service").length})`, href: "/app/shop?k=service", on: tab === "service" }]} />
        {list.length ? <div class="list">{list.map((i) => {
          const st = status(i);
          return <a class="list-row nav" href={`/app/shop/${i.id}`}>
            <Thumb img={i.img} kind={i.kind} />
            <span class="list-text"><span class="body b clamp1">{i.title}</span><span class="foot muted clamp1">{i.details.priceFrom ? "from " : ""}{i.price} · {itemFacts(i.kind, i.details).join(" · ")}</span></span>
            <span class={`pill ${st.tone}`}>{st.label}</span>
            <Icon n="chevron" s={16} c="#c7c7cc" /></a>;
        })}</div>
          : <div class="empty"><Icon n={tab === "service" ? "users" : "bag"} s={40} c="#8e8e93" /><span class="headline">No {noun}s yet</span>
            <span class="foot muted">{tab === "service" ? "Add what you do — a repair, a fitting, a custom order. Buyers book and pay through escrow." : "Add what you sell with a photo and a price. Buyers pay through escrow on NEAR."}</span>
            <a class="btn" href={`/app/shop/new?kind=${tab}`}><Icon n="plus" />Add {noun}</a></div>}
        {tab === "product" && suggestions.length ? <section class="group"><span class="group-h">Suggested from your photos</span>
          <div class="list">{suggestions.map((sg, k) => <div class="list-row">
            <Thumb img={sg.img} kind="product" />
            <span class="list-text"><span class="body b clamp1">{sg.title}</span><span class="foot muted clamp1">{sg.description}</span></span>
            <a class="btn soft sm" href={`/app/shop/new?kind=product&suggest=${k}`}>Add</a></div>)}</div>
          <span class="group-f">AI spotted these in your photos. Add one, set a price, and it is in your store.</span></section> : null}
        <span class="cap muted">Everything you add can also appear in your AI posts. <a href={`/h/${store.handle}/`} target="_blank" rel="noopener">Open your store ›</a></span>
      </Shell>
    </UiPage>
  );
};

const STOCKS = [["in_stock", "In stock"], ["made_to_order", "Made to order"], ["sold_out", "Sold out"]] as const;
const MODES = [["online", "Online"], ["seller", "At my place"], ["buyer", "At the buyer's"]] as const;

/** Add or edit one product or service: grouped fields like iOS Settings. */
export const ItemEditPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; item: ShopItem | null; kind: "product" | "service"; photos: PhotoPick[]; prefill?: Suggestion | null }> = ({ cfg, test, store, item, kind, photos, prefill }) => {
  const d = item?.details ?? {};
  const k = item?.kind === "service" ? "service" : item ? "product" : kind;
  const photo = item?.photoMediaId ?? prefill?.photoMediaId ?? null;
  const st = item ? status(item) : null;
  return (
    <UiPage title={`${item ? "Edit" : "Add"} · Shop`} cfg={cfg} page="app" test={test}>
      <Shell active="Shop" store={store}>
        <a class="back" href={`/app/shop?k=${k}`}><Icon n="chevron" s={18} />Shop</a>
        <PageHead kicker={st ? st.label : "New"} title={item ? item.title : k === "service" ? "New service" : "New product"} />
        {item?.held ? <div class="card warn" style="gap:10px"><span class="headline">Needs a small change</span>
          <span class="sub">Our safety check found: {item.held}</span><span class="foot muted">Buyers don't see it until it's fixed. Nothing counts against your store.</span>
          <div class="row" style="gap:10px;flex-wrap:wrap"><button class="btn" data-item-fix={item.id}><Icon n="sparkles" />Fix with AI</button><span class="foot muted" style="align-self:center">or edit the text below and save</span></div></div> : null}
        <form id="item-form" class="stack form" style="gap:24px;max-width:640px" data-id={item?.id ?? ""} data-kind={k}>
          {item ? <input type="hidden" name="kind" value={k} /> : <div class="group"><span class="group-h">Type</span>
            <Segmented name="kind" items={[{ label: "Product", value: "product", on: k === "product" }, { label: "Service", value: "service", on: k === "service" }]} /><input type="hidden" name="kind" value={k} /></div>}
          <div class="group"><span class="group-h">Photo</span>
            <div class="photo-pick" role="radiogroup">
              <label class="pick-add"><Icon n="camera" s={22} /><span class="cap">Add</span><input type="file" accept="image/*" class="hidden" data-item-upload /></label>
              {[...photos.filter((p) => p.id === photo), ...photos.filter((p) => p.id !== photo)].map((p) => <label class={`pick ${p.id === photo ? "on" : ""}`} style={`background-image:url('${p.img}')`}><input type="radio" name="photo" value={p.id} checked={p.id === photo} class="hidden" /></label>)}
            </div>
            <span class="group-f">Pick one of your photos or AI pictures, or add a new one.</span></div>
          <div class="group"><span class="group-h">Details</span>
            <div class="list">
              <label class="list-field"><span>Name</span><input name="title" required minlength={2} maxlength={120} value={item?.title ?? prefill?.title ?? ""} placeholder={k === "service" ? "Security upgrade for your phone" : "Gold iPhone 16 Pro, black diamonds"} /></label>
              <label class="list-field"><span>Price, {cfg.token}</span><input name="price" type="number" inputmode="decimal" min="0.5" step="0.01" required value={item ? String(item.priceNumber) : ""} placeholder="0.00" /></label>
              <label class="list-field" data-for="service"><span>“From” price</span><span class="grow foot muted">The buyer pays this now; you agree the rest</span><input type="checkbox" class="switch" name="priceFrom" checked={!!d.priceFrom} /></label>
              <label class="list-field top"><span>About</span><textarea name="description" rows={4} maxlength={2000} placeholder={k === "service" ? "What you do, what's included, how it works" : "Materials, size, what's in the box"}>{item?.description ?? prefill?.description ?? ""}</textarea></label>
            </div></div>
          <div class="group" data-for="product"><span class="group-h">Stock & delivery</span>
            <Segmented name="stock" items={STOCKS.map(([v, l]) => ({ label: l, value: v, on: (d.stock ?? "in_stock") === v }))} /><input type="hidden" name="stock" value={d.stock ?? "in_stock"} />
            <div class="list">
              <label class="list-field"><span>Ships</span><select name="shipping">{[["world", "Worldwide"], ["countries", "To some countries"], ["pickup", "Pickup only"]].map(([v, l]) => <option value={v} selected={(d.shipping ?? "world") === v}>{l}</option>)}</select></label>
              <label class="list-field" data-ship-countries><span>Countries</span><input name="countries" maxlength={120} value={d.countries ?? ""} placeholder="UAE, Saudi Arabia, UK" /></label>
            </div></div>
          <div class="group" data-for="product"><span class="group-h">Options (optional)</span>
            <div class="list">
              <label class="list-field"><span>Option</span><input name="optionName" maxlength={30} value={d.optionName ?? ""} placeholder="Colour" /></label>
              <label class="list-field"><span>Choices</span><input name="options" maxlength={400} value={(item?.options ?? []).join(", ")} placeholder="Yellow gold, Rose gold, White gold" /></label>
            </div><span class="group-f">Separate choices with commas. The buyer picks one at checkout.</span></div>
          <div class="group" data-for="service"><span class="group-h">How it works</span>
            <Segmented name="mode" items={MODES.map(([v, l]) => ({ label: l, value: v, on: (d.mode ?? "online") === v }))} /><input type="hidden" name="mode" value={d.mode ?? "online"} />
            <div class="list">
              <label class="list-field"><span>Ready in</span><input name="deliveryDays" type="number" inputmode="numeric" min="1" max="365" value={String(d.deliveryDays ?? 7)} /><span class="foot muted">days</span></label>
              <label class="list-field top"><span>Ask the buyer</span><input name="question" maxlength={200} value={d.question ?? ""} placeholder="Which phone model is it for?" /></label>
            </div><span class="group-f">The buyer answers this when they order.</span></div>
          <button class="btn block lg" type="submit">{item ? "Save" : `Add to my store`}</button>
          <output class="foot" data-item-out aria-live="polite"></output>
          {item ? <div class="list">
            <button class="list-row btn-row" type="button" data-item-visibility={item.id} data-active={item.active ? "0" : "1"}><Icon n={item.active ? "eyeoff" : "eye"} s={18} />{item.active ? "Hide from store" : "Show in store again"}</button>
            <a class="list-row btn-row" href={`/h/${store.handle}/i/${item.id}`} target="_blank" rel="noopener"><Icon n="arrow" s={18} />View in store</a></div> : null}
          {item ? <span class="cap muted">Hidden items stay in past orders. You can show them again any time.</span> : null}
        </form>
      </Shell>
    </UiPage>
  );
};
