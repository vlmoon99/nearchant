// Browser half of the example (example.ts bundles it). Asks the server for a challenge, lets the person pick a
// wallet, sends the signature back, shows who signed in.
import { finishRedirectSignIn, signIn, type Challenge, type SignedLogin } from "./src/index.js";

const out = document.getElementById("out")!;
async function verify(signed: SignedLogin) {
  const r = await fetch("/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  const j = (await r.json()) as { accountId?: string; reason?: string };
  out.textContent = r.ok ? `Signed in as ${j.accountId}` : `Refused: ${j.reason}`;
}

document.getElementById("go")!.addEventListener("click", async () => {
  out.textContent = "";
  const signed = await signIn({ network: "testnet", challenge: () => fetch("/challenge").then((r) => r.json() as Promise<Challenge>) });
  if (signed) await verify(signed);
});

// Back from a redirect wallet (MyNearWallet)?
const back = finishRedirectSignIn();
if (back && "error" in back) out.textContent = `The wallet said: ${back.error}`;
else if (back) { history.replaceState(null, "", location.pathname); void verify(back); }
