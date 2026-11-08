// Small shared controls (seller app and store pages): segmented controls and copy buttons.
export function mountUi(root: ParentNode = document): void {
  // Segmented control → its hidden input (a sibling named after data-seg).
  root.querySelectorAll<HTMLElement>("[data-seg]").forEach((seg) => {
    const input = seg.parentElement?.querySelector<HTMLInputElement>(`input[name="${seg.dataset.seg}"]`);
    seg.querySelectorAll<HTMLButtonElement>("button[data-value]").forEach((b) => b.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b)); });
      if (input) { input.value = b.dataset.value!; input.dispatchEvent(new Event("change", { bubbles: true })); }
    }));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy!); } catch { return; }
    const was = b.innerHTML;
    b.textContent = "✓";
    setTimeout(() => { b.innerHTML = was; }, 1200);
  }));
}

export type Step = { label: string; state: "todo" | "now" | "done" | "bad" };
export type SheetButton = { label: string; primary?: boolean; href?: string; onClick?: () => void };

/** A bottom sheet (centred on desktop) with a title, a message, optional steps and buttons — for actions that take
 *  a while (paying): what is happening now, then a clear "done" or "didn't work" with the reason. */
export function sheet(title: string, text = "") {
  const back = document.createElement("div");
  back.className = "sheet-back";
  back.innerHTML = `<div class="sheet card" role="dialog" aria-modal="true" aria-live="polite"><button class="sheet-x" aria-label="Close">×</button><span class="sheet-ic" data-i></span><span class="headline" data-t></span><span class="sub" data-m style="white-space:pre-line"></span><ol class="steps" data-s></ol><div class="stack" style="gap:8px" data-b></div></div>`;
  let closable = false;
  const close = () => back.remove();
  back.addEventListener("click", (e) => { if (closable && e.target === back) close(); });
  back.querySelector(".sheet-x")!.addEventListener("click", () => { if (closable) close(); });
  const q = <T extends HTMLElement>(k: string) => back.querySelector<T>(`[data-${k}]`)!;
  const api = {
    set(t: string, m = "", o: { steps?: Step[]; buttons?: SheetButton[]; icon?: "ok" | "bad" | "busy" } = {}) {
      q("t").textContent = t; q("m").textContent = m;
      q("i").className = `sheet-ic ${o.icon ?? ""}`; q("i").textContent = o.icon === "ok" ? "✓" : o.icon === "bad" ? "!" : "";
      if (o.icon === "busy") q("i").innerHTML = '<span class="spin"></span>';
      const s = q("s"); s.replaceChildren(...(o.steps ?? []).map((x) => { const li = document.createElement("li"); li.className = x.state; li.textContent = x.label; return li; }));
      const bs = o.buttons ?? [];
      closable = bs.length > 0; (back.querySelector(".sheet-x") as HTMLElement).hidden = !closable;
      const box = q("b"); box.replaceChildren(...bs.map((x) => {
        const el = document.createElement(x.href ? "a" : "button");
        el.className = x.primary ? "btn" : "btn secondary"; el.textContent = x.label;
        if (x.href) (el as HTMLAnchorElement).href = x.href;
        el.addEventListener("click", () => { if (x.onClick) x.onClick(); else if (!x.href) close(); });
        return el;
      }));
    },
    close,
  };
  api.set(title, text, { icon: "busy" });
  document.body.append(back);
  return api;
}

/** nUSD balance of an account, read straight from NEAR (null when it can't be read). */
export async function tokenBalance(rpcUrl: string, contract: string, accountId: string): Promise<bigint | null> {
  try {
    const args = btoa(JSON.stringify({ account_id: accountId }));
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: "ft_balance_of", args_base64: args } }) });
    const j = await r.json() as { result?: { result?: number[] } };
    return j.result?.result ? BigInt(JSON.parse(String.fromCharCode(...j.result.result)) as string) : null;
  } catch { return null; }
}
export const fmtUnits = (u: bigint, decimals: number) => (Number(u) / 10 ** decimals).toLocaleString("en", { maximumFractionDigits: 2 });
