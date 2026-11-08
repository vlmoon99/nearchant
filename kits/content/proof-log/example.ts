// npx tsx example.ts [file]
// With PROOF_LOG_CONTRACT, AUTHOR_ACCOUNT and AUTHOR_KEY set, records a fingerprint on testnet and checks it back.
// Without them it prints the entry it would write. Pass a file path to prove a file; otherwise a sample post is used.
import { readFile } from "node:fs/promises";
import { ProofLog, fingerprint, keySigner } from "./src/index.js";

const env = process.env;
const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
const file = process.argv[2];

// A post made by AI: caption + picture, with the model that wrote it (like Nearchant's content store does).
const content = file ? await readFile(file) : { caption: "Fresh sourdough today, 6€ a loaf. Come by before noon!", image: Buffer.from("…png bytes…") };
const meta = { producer: file ? "file" : "model:qwen3 + qwen-image-edit", subject: file ? `file:${file}` : "post:demo-1", madeAt: new Date() };
const entry = fingerprint(content, meta);

const contractId = env.PROOF_LOG_CONTRACT;
if (!contractId || !env.AUTHOR_ACCOUNT || !env.AUTHOR_KEY) {
  console.log("Dry run (set PROOF_LOG_CONTRACT, AUTHOR_ACCOUNT, AUTHOR_KEY to write on testnet). The entry would be:\n");
  console.log(JSON.stringify(entry, null, 2));
  console.log(`\n→ ${contractId ?? "<proof-log>"}.record({ entry }) with ~0.01 NEAR attached for storage (the rest is refunded).`);
  process.exit(0);
}

const log = new ProofLog({ contractId, network, signer: keySigner({ network, accountId: env.AUTHOR_ACCOUNT, secretKey: env.AUTHOR_KEY }) });
const { id, existing } = await log.prove(content, meta);
console.log(existing ? `already recorded as #${id}` : `recorded #${id}`);
const found = await log.check(content, { authorId: env.AUTHOR_ACCOUNT });
if (found) console.log(`earliest proof: #${found.id} by ${found.author_id} at ${new Date(Number(BigInt(found.created_at) / 1_000_000n)).toISOString()} (block ${found.block_height})`);
