import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource } from "./custody-guard.mjs";

const bad = [
  `const acct = privateKeyToAccount(process.env.PK)`,
  `const w = new ethers.Wallet(pk, provider)`,
  `const w = Wallet.createRandom()`,
  `const kp = Keypair.generate()`,
  `await client.signTransaction(tx)`,
  `CREATE TABLE balances (id uuid)`,
  `const privateKey = await kms.get()`,
  `export const internalWallets = pgTable("internal_wallets", {})`,
];
for (const src of bad) {
  test(`flags: ${src}`, () => assert.equal(scanSource(src).findings.length > 0, true));
}

test("ignores prose comments describing the invariant", () => {
  assert.equal(scanSource(`// no balances table, no private keys`).findings.length, 0);
  assert.equal(scanSource(`-- NEVER a balances table`).findings.length, 0);
});

test("ignores ordinary payment code", () => {
  const src = `const { writeContract } = useWriteContract();\nconst hash = await writeContract({ functionName: "transfer" });`;
  assert.equal(scanSource(src).findings.length, 0);
});

test("honours a justified allow comment", () => {
  const src = `// custody-guard-allow: ops gas wallet, reviewed\nconst a = privateKeyToAccount(x)`;
  const r = scanSource(src);
  assert.equal(r.findings.length, 0);
  assert.equal(r.allowed.length, 1);
});
