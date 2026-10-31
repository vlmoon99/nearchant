import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Network = "testnet" | "mainnet";

export interface PlatformAccounts {
  root: string;
  nusd: string;
  orders: string;
  billing: string;
  proofs: string;
  escrow: string;
  treasury: string;
  relayer: string;
}

/** Reads config/defaults/accounts.yaml (the only place account ids live). */
export function loadAccounts(file: string, network: Network): PlatformAccounts {
  const all = parse(readFileSync(file, "utf8")) as Record<string, Partial<PlatformAccounts>>;
  const a = all[network];
  if (!a?.root) throw new Error(`${file}: no accounts for ${network}`);
  const need = ["nusd", "orders", "billing", "proofs", "escrow", "treasury", "relayer"] as const;
  const missing = need.filter((k) => !a[k]);
  if (missing.length) throw new Error(`${file}: ${network} is missing ${missing.join(", ")}`);
  return a as PlatformAccounts;
}
