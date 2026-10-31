import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Network } from "@nearchant/near";

export interface GatewayConfig {
  profile: "operator" | "free-local" | "demo";
  network: Network;
  public_url: string;
  base_domains: string[];
  dashboard_origin: string;
  rpc_urls: string[];
  listen: { host: string; port: number };
  token: { symbol: string; decimals: number; test: boolean };
}

export function loadGatewayConfig(file: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const c = { ...(parse(readFileSync(file, "utf8")) as GatewayConfig), ...overrides };
  if (!["operator", "free-local", "demo"].includes(c.profile)) throw new Error(`${file}: bad profile ${c.profile}`);
  if (!/^https?:\/\/[^/]+$/.test(c.public_url)) throw new Error(`${file}: public_url must be an origin like https://example.com`);
  if (!c.base_domains?.length) throw new Error(`${file}: base_domains is empty`);
  return c;
}

/** "5000000" → "5" ; "5050000" → "5.05" (base units → display). */
export function formatUnits(units: string, decimals: number): string {
  const s = units.padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
