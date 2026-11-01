import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { fillWorkflow, type LabVariant } from "@nearchant/providers";

const cfg = join(import.meta.dirname, "../../../config");
const lab = parse(readFileSync(join(cfg, "image-lab.yaml"), "utf8")) as { variants: LabVariant[] };

describe("image lab workflows", () => {
  it("every variant fills without leftover placeholders and its overrides hit real nodes", () => {
    for (const v of lab.variants) {
      const t = JSON.parse(readFileSync(join(cfg, "image-lab", v.workflow), "utf8"));
      const wf = fillWorkflow(t, { prompt: "p", ref: "in.png", seed: 7, width: 1024, height: 1280, set: v.set });
      expect(JSON.stringify(wf), v.id).not.toMatch(/__[A-Z]+__/);
      for (const path of Object.keys(v.set ?? {})) { const [id, input] = path.split("."); expect(wf[id!]!.inputs[input!], `${v.id} ${path}`).toBe(v.set![path]); }
    }
  });
  it("does not change the template", () => {
    const t = JSON.parse(readFileSync(join(cfg, "image-lab", "qwen_edit.json"), "utf8"));
    fillWorkflow(t, { prompt: "x", ref: "r", seed: 1, width: 1, height: 1, set: { "31.steps": 20 } });
    expect(JSON.stringify(t)).toContain("__PROMPT__");
  });
  it("refuses an override for a missing node", () => {
    expect(() => fillWorkflow({}, { prompt: "x", seed: 1, width: 1, height: 1, set: { "99.steps": 1 } })).toThrow(/no node 99/);
  });
});
