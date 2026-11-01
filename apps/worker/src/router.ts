import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ReplayStore, Router } from "@nearchant/providers";

/**
 * The model router for this process. `REPLAY_DIR` + no `NEARAI_API_KEY` → replay-only (judges, ADR 0013);
 * `RECORD_DIR` → live, recording every envelope for future replays.
 */
export async function makeRouter(configFile: string) {
  const config = parse(readFileSync(configFile, "utf8"));
  const replayDir = process.env.REPLAY_DIR;
  if (replayDir && !process.env.NEARAI_API_KEY) {
    const caps = ["chat", "vision", "image.generate", "embed"];
    return Router.fromConfig({
      endpoints: [{ id: "replay", adapter: "replay", base_url: replayDir, privacy_tier: "local", capabilities: caps }],
      routing: { ...Object.fromEntries(caps.map((c) => [c, ["replay"]])), private_data_allowed_tiers: ["tee", "local"] },
      models: config.models,
    });
  }
  const r = Router.fromConfig(config, process.env.RECORD_DIR ? { record: new ReplayStore(process.env.RECORD_DIR) } : {});
  await r.discover();
  return r;
}
