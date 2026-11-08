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
