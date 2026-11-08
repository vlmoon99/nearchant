// A bottom sheet (centred on desktop) that walks the buyer through a payment: steps with a spinner on the current
// one, then a clear "Paid ✓" or "didn't go through" with the reason and "Try again". Style: checkout.css.
import { payErrorText, payWithEscrow, type PayOptions, type PayResult, type PayStep, type StepEvent } from "./pay.js";

export type StepState = "todo" | "now" | "done" | "bad";
export interface SheetStep { label: string; state: StepState }
export interface SheetButton { label: string; primary?: boolean; href?: string; onClick?: () => void }
export interface SheetView { steps?: SheetStep[]; buttons?: SheetButton[]; icon?: "ok" | "bad" | "busy" }

export interface PaySheetOptions {
  title?: string;
  /** Under the title while paying, e.g. "5 USDC to Alice's shop. Keep this window open." */
  subtitle?: string;
  labels?: Partial<Record<PayStep, string>>;
  /** Where the sheet is attached. Default document.body. */
  root?: HTMLElement;
}

const ORDER: PayStep[] = ["wallet", "pay", "confirm"];
const LABELS: Record<PayStep, string> = { wallet: "Preparing wallet", pay: "Paying", confirm: "Confirming on NEAR" };

export class PaySheet {
  readonly element: HTMLDivElement;
  private closable = false;
  private states: Record<PayStep, StepState> = { wallet: "todo", pay: "todo", confirm: "todo" };
  private readonly labels: Record<PayStep, string>;
  private onClose: (() => void) | null = null;

  constructor(private readonly o: PaySheetOptions = {}) {
    this.labels = { ...LABELS, ...o.labels };
    const back = document.createElement("div");
    back.className = "ncpay-back";
    back.innerHTML = `<div class="ncpay-sheet" role="dialog" aria-modal="true" aria-live="polite"><button type="button" class="ncpay-x" aria-label="Close">×</button><span class="ncpay-ic" data-i></span><span class="ncpay-title" data-t></span><span class="ncpay-text" data-m></span><ol class="ncpay-steps" data-s></ol><div class="ncpay-buttons" data-b></div></div>`;
    back.addEventListener("click", (e) => { if (this.closable && e.target === back) this.close(); });
    back.querySelector(".ncpay-x")!.addEventListener("click", () => { if (this.closable) this.close(); });
    back.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.closable) this.close(); });
    this.element = back;
  }

  private q<T extends HTMLElement>(k: string): T { return this.element.querySelector<T>(`[data-${k}]`)!; }
  private steps(): SheetStep[] { return ORDER.map((s) => ({ label: this.labels[s], state: this.states[s] })); }

  /** Shows the sheet in its "paying" state. */
  open(): this {
    this.states = { wallet: "todo", pay: "todo", confirm: "todo" };
    this.set(this.o.title ?? "Paying…", this.o.subtitle ?? "Keep this window open.", { steps: this.steps(), icon: "busy" });
    if (!this.element.isConnected) (this.o.root ?? document.body).append(this.element);
    return this;
  }

  /** Low-level: title, text, steps, buttons, icon. With buttons the sheet can be closed; without, it can't. */
  set(title: string, text = "", v: SheetView = {}): void {
    this.q("t").textContent = title;
    this.q("m").textContent = text;
    const ic = this.q("i");
    ic.className = `ncpay-ic ${v.icon ?? ""}`;
    ic.textContent = v.icon === "ok" ? "✓" : v.icon === "bad" ? "!" : "";
    if (v.icon === "busy") ic.innerHTML = '<span class="ncpay-spin"></span>';
    this.q("s").replaceChildren(...(v.steps ?? []).map((x) => { const li = document.createElement("li"); li.className = x.state; li.textContent = x.label; return li; }));
    const bs = v.buttons ?? [];
    this.closable = bs.length > 0;
    this.element.querySelector<HTMLElement>(".ncpay-x")!.hidden = !this.closable;
    this.q("b").replaceChildren(...bs.map((x) => {
      const el = document.createElement(x.href ? "a" : "button");
      el.className = x.primary ? "ncpay-btn" : "ncpay-btn secondary";
      el.textContent = x.label;
      if (x.href) (el as HTMLAnchorElement).href = x.href; else (el as HTMLButtonElement).type = "button";
      el.addEventListener("click", () => { if (x.onClick) x.onClick(); else if (!x.href) this.close(); });
      return el;
    }));
    if (bs.length) (this.q("b").firstElementChild as HTMLElement | null)?.focus();
  }

  /** Feed it payWithEscrow's onStep events. */
  step(e: StepEvent, subtitle?: string): void {
    const i = ORDER.indexOf(e.step);
    ORDER.forEach((s, j) => { if (j < i) this.states[s] = "done"; });
    this.states[e.step] = e.state;
    const text = subtitle ?? (e.state === "now" && e.detail ? e.detail : this.q("m").textContent ?? "");
    this.set(this.o.title ?? "Paying…", text, { steps: this.steps(), icon: e.state === "bad" ? "bad" : "busy" });
  }

  paid(o: { title?: string; text?: string; buttons?: SheetButton[] } = {}): void {
    ORDER.forEach((s) => { this.states[s] = "done"; });
    this.set(o.title ?? "Paid ✓", o.text ?? "Your money is safe in escrow on NEAR.", { steps: this.steps(), icon: "ok", buttons: o.buttons ?? [{ label: "Done", primary: true }] });
  }

  pending(o: { title?: string; text?: string; buttons?: SheetButton[] } = {}): void {
    this.set(o.title ?? "Payment sent", o.text ?? "NEAR is taking longer than usual to confirm it.", { steps: this.steps(), icon: "busy", buttons: o.buttons ?? [{ label: "Close", primary: true }] });
  }

  failed(o: { title?: string; text: string; retry?: () => void; buttons?: SheetButton[] }): void {
    for (const s of ORDER) if (this.states[s] === "now") this.states[s] = "bad";
    const buttons = o.buttons ?? [...(o.retry ? [{ label: "Try again", primary: true, onClick: o.retry }] : []), { label: "Close" }];
    this.set(o.title ?? "Payment didn't go through", o.text, { steps: this.steps(), icon: "bad", buttons });
  }

  close(): void {
    this.element.remove();
    const f = this.onClose; this.onClose = null; f?.();
  }

  /** Resolves when the sheet is closed. */
  closed(): Promise<void> { return new Promise((r) => { const prev = this.onClose; this.onClose = () => { prev?.(); r(); }; }); }
}

export interface PayWithSheetOptions extends PayOptions {
  sheet?: PaySheetOptions;
  /** Text and buttons on success; get the result so you can link to the order. */
  paid?: (r: PayResult) => { title?: string; text?: string; buttons?: SheetButton[] };
}

/** payWithEscrow inside a PaySheet, with "Try again" on failure. Resolves with the result once paid (or pending),
 *  or null when the buyer closes the sheet after a failure. */
export function payWithSheet(o: PayWithSheetOptions): Promise<PayResult | null> {
  const sheet = new PaySheet(o.sheet);
  return new Promise((resolve) => {
    const attempt = async () => {
      sheet.open();
      try {
        const r = await payWithEscrow({ ...o, onStep: (e) => { sheet.step(e); o.onStep?.(e); } });
        if (r.status === "paid") sheet.paid(o.paid?.(r)); else sheet.pending(o.paid?.(r));
        resolve(r);
      } catch (e) {
        const { maybeSent, code } = e as { maybeSent?: boolean; code?: string };
        const note = code === "refused" ? "" : maybeSent ? "\n\nIf the money left your wallet, trying again won't charge you twice." : "\n\nNo money left your wallet.";
        sheet.failed({ text: payErrorText(e) + note, retry: () => void attempt() });
      }
    };
    void sheet.closed().then(() => resolve(null));
    void attempt();
  });
}
