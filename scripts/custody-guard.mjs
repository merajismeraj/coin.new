#!/usr/bin/env node
// Custody guard (spec §7.2): coin.new must never construct a signer, generate
// or store a private key, or model balances/pooled funds. This fails CI on any
// source line that looks like it does.
//
// A line may be exempted only with an inline justification on the same or
// previous line:  // custody-guard-allow: <reason, reviewed by ...>
// Exemptions are printed on every run so they stay visible in CI logs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  // EVM (viem / ethers / web3) signers and key material
  { id: "viem-local-account", re: /\b(privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic)\b/ },
  { id: "ethers-wallet", re: /\bnew\s+(ethers\.)?(Wallet|HDNodeWallet|SigningKey)\s*\(|\b(Wallet|HDNodeWallet)\.(createRandom|fromMnemonic|fromPhrase|fromEncryptedJson)\b/ },
  { id: "web3-account", re: /\beth\.accounts\.(create|privateKeyToAccount|wallet)\b/ },
  // Solana key material
  { id: "solana-keypair", re: /\bKeypair\.(generate|fromSecretKey|fromSeed)\b/ },
  // Server-side signing of transactions
  { id: "server-sign", re: /\b(signTransaction|sendRawTransaction|signAllTransactions)\s*\(/ },
  // Key material names in code or schema
  { id: "key-material", re: /\b(private_?key|secret_?key|mnemonic|seed_?phrase)\b/i },
  // Data-model shapes that imply custody (spec §3 "deliberately absent")
  { id: "custody-table", re: /\b(balances|internal_wallets|pending_transfers|omnibus|escrow)\b/i },
];

const SCAN_DIRS = ["apps", "packages"];
const EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|sql|sol)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo"]);
const ALLOW = /custody-guard-allow:\s*\S+/;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXTS.test(name)) yield p;
  }
}

// Comments that merely *describe* the invariant ("no balances table") are fine;
// only flag comment lines that are not prose. Keeping it simple: pure comment
// lines are skipped, code lines (including trailing comments) are checked.
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|--)/;

export function scanSource(text) {
  const findings = [];
  const allowed = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    const code = line.replace(/\/\/.*$|--.*$/, "");
    for (const rule of RULES) {
      if (!rule.re.test(code)) continue;
      const hit = { line: i + 1, rule: rule.id, text: line.trim() };
      if (ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? "")) allowed.push(hit);
      else findings.push(hit);
    }
  });
  return { findings, allowed };
}

function main() {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  let failed = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file);
      const { findings, allowed } = scanSource(readFileSync(file, "utf8"));
      for (const f of allowed) console.log(`custody-guard: ALLOWED ${rel}:${f.line} [${f.rule}] ${f.text}`);
      for (const f of findings) {
        console.error(`custody-guard: ${rel}:${f.line} [${f.rule}] ${f.text}`);
        failed++;
      }
    }
  }
  if (failed) {
    console.error(`\ncustody-guard: ${failed} violation(s). coin.new must never hold keys, sign for, or pool user funds (spec §1, §2.2, §7.2).`);
    process.exit(1);
  }
  console.log("custody-guard: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
