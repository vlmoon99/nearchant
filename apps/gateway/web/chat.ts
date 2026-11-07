// Order chat (seller app and buyer order page): messages are off-chain, so they show up at once; the thread is
// fetched again every few seconds while the page is open. Text only, rendered as text (never as HTML).
type Msg = { id: number; author: "seller" | "buyer"; text: string; at: string };

export function mountChats(): void {
  document.querySelectorAll<HTMLElement>("[data-chat]").forEach((box) => {
    const url = box.dataset.chat!, me = box.dataset.me as Msg["author"];
    const log = box.querySelector<HTMLElement>(".chat-log")!, form = box.querySelector<HTMLFormElement>(".chat-form")!;
    const input = form.querySelector<HTMLInputElement>("input[name=text]")!, button = form.querySelector<HTMLButtonElement>("button")!;
    let shown = -1;
    const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const render = (msgs: Msg[]) => {
      const last = msgs.at(-1)?.id ?? 0;
      if (last === shown) return;
      shown = last;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.replaceChildren(...(msgs.length ? msgs.map((m) => {
        const b = document.createElement("div"); b.className = `bubble${m.author === me ? " me" : ""}`;
        const t = document.createElement("span"); t.textContent = m.text;
        const c = document.createElement("span"); c.className = "cap muted"; c.textContent = `${m.author === me ? "You" : me === "seller" ? "Buyer" : "Store"} · ${when(m.at)}`;
        b.append(t, c); return b;
      }) : [Object.assign(document.createElement("span"), { className: "foot muted", textContent: me === "seller" ? "No messages yet. Say hi or share the tracking number." : "No messages yet. Ask the store anything about your order." })]));
      if (atBottom || msgs.at(-1)?.author === me) log.scrollTop = log.scrollHeight;
    };
    const load = async () => {
      const r = await fetch(url, { credentials: "same-origin" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (r?.messages) render(r.messages as Msg[]);
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      button.disabled = true;
      const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const j = await r.json().catch(() => ({}));
      button.disabled = false;
      if (!r.ok) { input.setCustomValidity((j as { error?: string }).error ?? "Couldn’t send"); input.reportValidity(); setTimeout(() => input.setCustomValidity(""), 3000); return; }
      input.value = "";
      await load();
    });
    log.scrollTop = log.scrollHeight;
    void load();
    setInterval(() => { if (document.visibilityState === "visible") void load(); }, 4000);
  });
}
