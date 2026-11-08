// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { checkForm, clearOnInput, contactRules, rules } from "../src/index.js";

let form: HTMLFormElement, out: HTMLOutputElement;
beforeEach(() => {
  document.body.innerHTML = `<form>
    <label class="row"><span>Name</span><input name="name"></label>
    <label class="row"><span>Phone</span><input name="phone"></label>
    <label class="row"><span>Email</span><input name="email"></label>
    <output hidden></output></form>`;
  form = document.querySelector("form")!;
  out = form.querySelector("output")!;
});
const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v; };

describe("checkForm", () => {
  it("marks every missing field and lists them in one line", () => {
    const r = checkForm(form, contactRules(), { out, wrapper: ".row" });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.name)).toEqual(["name", "phone"]); // no address field: that rule is skipped
    expect(out.hidden).toBe(false);
    expect(out.textContent).toBe("Add your name · Add a phone number or an email");
    expect(form.querySelectorAll(".row.ncpay-invalid")).toHaveLength(2);
    expect(form.querySelector("[name=name]")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(form.querySelector("[name=name]"));
  });

  it("checks phone format and email", () => {
    set("name", "Ann"); set("phone", "212 555"); set("email", "nope");
    const r = checkForm(form, contactRules(), { out });
    expect(r.problems.map((p) => p.message)).toEqual(["Write the phone with the country code, like +1 212 555 0100", "Check the email"]);
  });

  it("passes a good form and hides the line", () => {
    set("name", "Ann"); set("phone", "+1 (212) 555-0100");
    expect(checkForm(form, contactRules(), { out }).ok).toBe(true);
    expect(out.hidden).toBe(true);
    expect(form.querySelector(".ncpay-invalid")).toBeNull();
  });

  it("clears a mark when the field is edited", () => {
    clearOnInput(form, { wrapper: ".row" });
    checkForm(form, [rules.required("name", "Add your name")], { wrapper: ".row" });
    const input = form.querySelector<HTMLInputElement>("[name=name]")!;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form.querySelector(".ncpay-invalid")).toBeNull();
  });
});
