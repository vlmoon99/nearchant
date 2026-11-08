// npx tsx example.ts
// With ESCROW_CONTRACT, ESCROW_TOKEN, BUYER_ACCOUNT, BUYER_KEY, SELLER_ACCOUNT, SELLER_KEY set, runs a real order on
// testnet: pay → mark delivered → accept → paid out. Without them it prints what it would do.
// Amount: ESCROW_AMOUNT (token base units, default "1000000" = 1 token at 6 decimals).
import { EscrowClient, keySigner, newOrderId, orderMsg, orderStage } from "./src/index.js";

const env = process.env;
const contractId = env.ESCROW_CONTRACT;
const token = env.ESCROW_TOKEN;
const amount = env.ESCROW_AMOUNT ?? "1000000";
const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
const live = contractId && token && env.BUYER_ACCOUNT && env.BUYER_KEY && env.SELLER_ACCOUNT && env.SELLER_KEY;

const orderId = newOrderId();
if (!live) {
  const seller = env.SELLER_ACCOUNT ?? "seller.testnet";
  console.log("Dry run (set ESCROW_CONTRACT, ESCROW_TOKEN, BUYER_ACCOUNT, BUYER_KEY, SELLER_ACCOUNT, SELLER_KEY to run on testnet).\n");
  console.log("1. buyer  →", token ?? "<token>", "ft_transfer_call", JSON.stringify({ receiver_id: contractId ?? "<escrow>", amount, msg: orderMsg(orderId, seller) }), "(1 yoctoNEAR)");
  console.log("   status:", orderStage("Held").label, "—", orderStage("Held").note);
  console.log("2. seller →", contractId ?? "<escrow>", "mark_delivered", JSON.stringify({ order_id: orderId, proof_id: null }));
  console.log("   status:", orderStage("Delivered").label, "—", orderStage("Delivered").note);
  console.log("3. buyer  →", contractId ?? "<escrow>", "accept", JSON.stringify({ order_id: orderId }));
  console.log("   status:", orderStage("Released").label, "—", orderStage("Released").note);
  process.exit(0);
}

const escrow = new EscrowClient({ contractId, network });
const buyer = escrow.as(keySigner({ network, accountId: env.BUYER_ACCOUNT!, secretKey: env.BUYER_KEY! }));
const seller = escrow.as(keySigner({ network, accountId: env.SELLER_ACCOUNT!, secretKey: env.SELLER_KEY! }));

const params = await escrow.getParams();
console.log("escrow params:", params);
const paid = await buyer.pay({ orderId, seller: env.SELLER_ACCOUNT!, token, amount, ensureStorage: true });
console.log("paid:", paid.paid, "used:", paid.used, "status:", paid.order?.status);
if (!paid.paid) process.exit(1);
console.log("delivered:", await seller.markDelivered(orderId));
console.log("accepted:", await buyer.accept(orderId));
const o = await escrow.getOrder(orderId);
console.log("final:", o?.status, "—", orderStage(o?.status, "seller").note);
