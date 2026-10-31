// Operator CLI.  node dist/admin-cli.js create-shop <handle> "<name>" "<bio>"
// env: DATABASE_URL, NEARCHANT_SECRET_KEY, NEAR_RELAYER_KEY. Prints the new owner key once — store it (Keychain).
import { join, resolve } from "node:path";
import { KeyPair } from "near-api-js";
import { connect, createShop, runMigrations, PgStore, Sealer } from "@nearchant/db";
import { Chain, loadAccounts } from "@nearchant/near";
import { loadGatewayConfig } from "./config.js";

const root = resolve(import.meta.dirname, "../../..");
const config = loadGatewayConfig(join(root, "config/gateway.yaml"));
const accounts = loadAccounts(join(root, "config/defaults/accounts.yaml"), config.network);
const need = (k: string) => process.env[k] ?? (console.error(`${k} is not set`), process.exit(2));

const [cmd, handle, name, bio] = process.argv.slice(2);
if (cmd !== "create-shop" || !handle || !name) {
  console.error('usage: admin-cli create-shop <handle> "<name>" "<bio>"');
  process.exit(2);
}
const conn = connect(need("DATABASE_URL"));
await runMigrations(conn.db);
const chain = new Chain({ rpcUrls: config.rpc_urls, relayer: { accountId: accounts.relayer, secretKey: need("NEAR_RELAYER_KEY") } });
const owner = KeyPair.fromRandom("ed25519");
const { accountId } = await createShop({ chain, accounts, db: conn.db, sealer: new Sealer(need("NEARCHANT_SECRET_KEY")) }, {
  handle, ownerPublicKey: owner.getPublicKey().toString(), card: { name, bio: bio ?? "", avatar_hash: null, links: [] },
});
await new PgStore(conn.db).upsertService({
  id: `${handle}-pitch-deck`, handle, title: "Pitch deck in 1 hour",
  description: "A 10-slide investor deck from your brief — researched, debated, written and designed by agents. PDF + PPTX.",
  priceUnits: "5000000", deliveryHours: 1, active: true,
});
console.log(JSON.stringify({ accountId, ownerSecretKey: owner.toString() }));
await conn.close();
