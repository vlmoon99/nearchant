// Check a checkout form before any wallet opens: mark each bad field right where it is and say everything that's
// missing in one line, so nobody waits for a wallet to hear "add a phone".

export interface Rule {
  /** Field name (form.elements[name]); the mark goes on this field. */
  name: string;
  message: string;
  /** True when the form is fine on this point. Gets the trimmed value of `name` and a getter for others. */
  test: (value: string, get: (name: string) => string) => boolean;
  /** Only check when the field exists in the form. Default true. */
  ifPresent?: boolean;
}

export interface CheckOptions {
  /** Where the one-line summary goes (shown/hidden with the `hidden` attribute). */
  out?: HTMLElement;
  /** The element that gets the invalid class: the closest ancestor matching this selector, else the field. */
  wrapper?: string;
  invalidClass?: string;
  /** Focus and scroll to the first bad field. Default true. */
  focus?: boolean;
}

export interface Problem { name: string; message: string }

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const fieldOf = (form: HTMLFormElement, n: string) => form.elements.namedItem(n) as Field | null;

export function checkForm(form: HTMLFormElement, rules: Rule[], o: CheckOptions = {}): { ok: boolean; problems: Problem[] } {
  const cls = o.invalidClass ?? "ncpay-invalid";
  form.querySelectorAll(`.${cls}`).forEach((x) => x.classList.remove(cls));
  const get = (n: string) => (fieldOf(form, n)?.value ?? "").trim();
  const problems: Problem[] = [];
  for (const r of rules) {
    const f = fieldOf(form, r.name);
    if (!f && r.ifPresent !== false) continue;
    // One message per field: the first failing rule wins.
    if (problems.some((p) => p.name === r.name)) continue;
    if (!r.test(get(r.name), get)) problems.push({ name: r.name, message: r.message });
  }
  for (const p of problems) {
    const f = fieldOf(form, p.name);
    const target = (o.wrapper ? f?.closest(o.wrapper) : null) ?? f;
    target?.classList.add(cls);
    f?.setAttribute("aria-invalid", "true");
  }
  form.querySelectorAll("[aria-invalid]").forEach((x) => { if (!problems.some((p) => p.name === x.getAttribute("name"))) x.removeAttribute("aria-invalid"); });
  if (o.out) {
    o.out.hidden = problems.length === 0;
    o.out.dataset.tone = problems.length ? "bad" : "";
    o.out.textContent = problems.map((p) => p.message).join(" · ");
  }
  if (problems.length && o.focus !== false) {
    const first = fieldOf(form, problems[0]!.name);
    first?.focus();
    first?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }
  return { ok: problems.length === 0, problems };
}

/** Removes the invalid mark from a field as soon as the buyer edits it. Returns a function that stops watching. */
export function clearOnInput(form: HTMLFormElement, o: Pick<CheckOptions, "wrapper" | "invalidClass"> = {}): () => void {
  const cls = o.invalidClass ?? "ncpay-invalid";
  const h = (e: Event) => {
    const f = e.target as HTMLElement;
    ((o.wrapper ? f.closest(o.wrapper) : null) ?? f).classList.remove(cls);
    f.removeAttribute("aria-invalid");
  };
  form.addEventListener("input", h);
  return () => form.removeEventListener("input", h);
}

const phoneDigits = (v: string) => v.replace(/[\s().-]/g, "");
/** Ready-made rules. */
export const rules = {
  required: (name: string, message: string, min = 1): Rule => ({ name, message, test: (v) => v.length >= min }),
  email: (name: string, message = "Check the email"): Rule => ({ name, message, test: (v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) }),
  /** International format (E.164) once spaces, dots, dashes and brackets are removed. Empty passes. */
  phone: (name: string, message = "Write the phone with the country code, like +1 212 555 0100"): Rule => ({ name, message, test: (v) => !v || /^\+[1-9]\d{6,14}$/.test(phoneDigits(v)) }),
  /** At least one of the fields is filled; the mark goes on the first. */
  oneOf: (names: string[], message: string): Rule => ({ name: names[0]!, message, test: (_v, get) => names.some((n) => get(n) !== "") }),
};

/** What Nearchant's store checkout asks: name, a phone or an email, and an address when the form has one. */
export const contactRules = (): Rule[] => [
  rules.required("name", "Add your name", 2),
  rules.oneOf(["phone", "email"], "Add a phone number or an email"),
  rules.phone("phone"),
  rules.email("email"),
  rules.required("address", "Add the delivery address", 8),
];
