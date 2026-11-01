// Wallet → Withdraw end to end on testnet: create a store in Chrome (its key stays in this browser), give the store
// test nUSD from the faucet (relayer key), then withdraw from the Wallet page — once to an account that holds nUSD,
// once to an account that never did (the store pays its registration) — and read the balances on chain.
//   NC_RELAYER_KEY=ed25519:… node e2e/withdraw.mjs [baseUrl] [registeredTo] [freshTo]
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { chromium } from "playwright-core";

const [base = "https://nearchant.com", registeredTo = "relayer.nearchant.testnet", freshTo = "nearchant.testnet"] = process.argv.slice(2);
const rpc = "https://rpc.testnet.near.org", nusd = "nusd.nearchant.testnet";
const provider = new JsonRpcProvider({ url: rpc });
const view = async (method, args) => JSON.parse(Buffer.from((await provider.query({ request_type: "call_function", finality: "final", account_id: nusd, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result).toString());
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${base}/start`);
await page.click("[data-go=sell]");
await page.fill("#store-name", `Wd Test ${Date.now().toString(36).slice(-4)}`);
await page.click("#create-store");
await page.waitForSelector("[data-step=show]:not(.hidden)", { timeout: 120_000 });
const handle = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith(":current-store"))));
const store = `${handle}.nearchant.testnet`;
log(`store ${store}`);

const relayer = new Account("relayer.nearchant.testnet", provider, new KeyPairSigner(KeyPair.fromString(process.env.NC_RELAYER_KEY)));
// New stores get the faucet amount when they are created; claim only if the store holds nothing.
if (BigInt(await view("ft_balance_of", { account_id: store })) === 0n) await relayer.callFunction({ contractId: nusd, methodName: "faucet_for", args: { account_id: store }, gas: 30n * 10n ** 12n });
log(`store has ${await view("ft_balance_of", { account_id: store })} units`);
const before = { reg: BigInt(await view("ft_balance_of", { account_id: registeredTo })), fresh: await view("storage_balance_of", { account_id: freshTo }) };
log(`${freshTo} registered with nUSD before: ${!!before.fresh}`);

for (const [to, amount] of [[registeredTo, "1"], [freshTo, "0.5"]]) {
  await page.goto(`${base}/app/wallet`); await page.waitForSelector("[data-withdraw-open]", { timeout: 30_000 });
  await page.click("[data-withdraw-open]");
  await page.fill("#withdraw-form [name=to]", to); await page.fill("#withdraw-form [name=amount]", amount);
  await page.click("#withdraw-form button[type=submit]");
  await page.waitForFunction(() => /^Sent |does not|has |not in|amount/.test(document.querySelector("#withdraw-out")?.textContent ?? ""), null, { timeout: 120_000 });
  log(`withdraw ${amount} → ${to}: ${await page.textContent("#withdraw-out")}`);
}
await page.screenshot({ path: "/tmp/nc-withdraw.png", fullPage: true });
log(`after: ${registeredTo} +${BigInt(await view("ft_balance_of", { account_id: registeredTo })) - before.reg} units; ${freshTo} registered: ${!!(await view("storage_balance_of", { account_id: freshTo }))}, balance ${await view("ft_balance_of", { account_id: freshTo })}; store left ${await view("ft_balance_of", { account_id: store })}`);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
