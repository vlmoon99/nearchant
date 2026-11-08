// Browser example: a "Pay" button that pays an escrow on NEAR testnet from a test wallet kept in this browser.
//   npm run example        (= esbuild example.ts --bundle --format=esm --alias:util=./shims/util.js --outfile=example.js)
//   npx serve .            then open http://localhost:3000/example.html?token=…&escrow=…&amount=…&seller=…&fund=…
// Settings come from the page URL (a browser has no env):
//   token   NEP-141 token contract           escrow  escrow contract (ft_on_transfer)
//   amount  base units, e.g. 1000000         seller  seller handle for Nearchant's escrow msg
//   fund    URL of YOUR sponsor endpoint: POST {accountId, publicKey} → sends the account NEAR + test tokens
import { createTestWallet, formatUnits, payWithSheet, tokenBalance } from "./src/index.js";

const q = new URLSearchParams(location.search);
const token = q.get("token") ?? "nusd.nearchant.testnet";
const escrow = q.get("escrow") ?? "orders.nearchant.testnet";
const amount = q.get("amount") ?? "1000000";
const decimals = Number(q.get("decimals") ?? 6);
const fundUrl = q.get("fund");

const wallet = createTestWallet({
  network: "testnet",
  fund: fundUrl ? async (accountId, publicKey) => {
    const r = await fetch(fundUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId, publicKey }) });
    if (!r.ok) throw new Error(`faucet said ${r.status}`);
  } : undefined,
});

const $ = (id: string) => document.getElementById(id)!;
$("account").textContent = wallet.accountId;
$("price").textContent = `${formatUnits(amount, decimals)} on ${token}`;

async function showBalance() {
  const b = await tokenBalance({ network: "testnet", token, accountId: wallet.accountId });
  $("balance").textContent = b === null ? "—" : formatUnits(b, decimals);
}
void showBalance();

$("pay").addEventListener("click", async () => {
  const orderId = `o-${crypto.randomUUID()}`;
  const r = await payWithSheet({
    network: "testnet", token, escrow, amount, orderId, seller: q.get("seller") ?? undefined,
    payer: () => wallet.ready(),
    sheet: { subtitle: `${formatUnits(amount, decimals)} into escrow. Keep this window open.` },
    paid: (x) => ({ text: `Order ${x.orderId} is held in escrow on NEAR.` }),
    onStep: (e) => console.log("step", e),
  });
  console.log("result", r);
  void showBalance();
});
