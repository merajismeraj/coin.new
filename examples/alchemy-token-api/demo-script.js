// Alchemy Token API demo (Ethereum Mainnet).
// Docs: https://docs.alchemy.com/reference/token-api-quickstart
//
// The API key is read from .env (ALCHEMY_API_KEY). It is never hard-coded.

import dotenv from "dotenv";

dotenv.config({ quiet: true });

const API_KEY = process.env.ALCHEMY_API_KEY;
if (!API_KEY) {
  console.error("Missing ALCHEMY_API_KEY. Create a .env file containing:\n  ALCHEMY_API_KEY=<your-key>");
  process.exit(1);
}
// ALCHEMY_RPC_URL is optional (e.g. to point at a local mock); defaults to Ethereum Mainnet.
const RPC_URL = process.env.ALCHEMY_RPC_URL ?? `https://eth-mainnet.g.alchemy.com/v2/${API_KEY}`;

// A well-known public wallet (vitalik.eth) with many ERC-20 balances. Swap in any address.
const WALLET = process.argv[2] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

let nextId = 1;

/** One JSON-RPC call to Alchemy. The Token API methods are ordinary RPC methods on the same endpoint. */
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result;
}

/** Raw integer (hex or decimal string) → human amount, exact (BigInt, no float rounding). */
function formatUnits(raw, decimals) {
  const v = BigInt(raw);
  if (!decimals) return v.toLocaleString("en-US");
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  const grouped = BigInt(whole).toLocaleString("en-US"); // BigInt: exact even for huge supplies
  return frac ? `${grouped}.${frac}` : grouped;
}

async function main() {
  console.log(`Wallet: ${WALLET}\n`);

  // 1) alchemy_getTokenBalances: every ERC-20 the wallet has ever held ("erc20"),
  //    or pass an array of contract addresses to check specific tokens.
  const balances = await rpc("alchemy_getTokenBalances", [WALLET, "erc20"]);
  const nonZero = balances.tokenBalances.filter((t) => !t.error && BigInt(t.tokenBalance ?? "0x0") > 0n);
  console.log(`1) alchemy_getTokenBalances → ${balances.tokenBalances.length} tokens returned, ${nonZero.length} with a non-zero balance`);
  if (balances.pageKey) console.log(`   (more results available: pass pageKey "${balances.pageKey}" to fetch the next page)`);

  // 2) alchemy_getTokenMetadata: balances are raw integers; metadata supplies
  //    decimals (to format them) plus name/symbol/logo.
  const top = nonZero.slice(0, 10);
  const metas = await Promise.all(top.map((t) => rpc("alchemy_getTokenMetadata", [t.contractAddress])));
  console.log(`\n2) alchemy_getTokenMetadata → first ${top.length} tokens, formatted:`);
  console.table(
    top.map((t, i) => ({
      symbol: metas[i].symbol ?? "?",
      name: (metas[i].name ?? "").slice(0, 28),
      balance: formatUnits(t.tokenBalance, metas[i].decimals ?? 0),
      decimals: metas[i].decimals,
      contract: t.contractAddress,
    })),
  );

  // 3) Specific contracts only: stablecoin balances (what coin.new settles in).
  const stables = await rpc("alchemy_getTokenBalances", [WALLET, [USDC, USDT]]);
  console.log("3) alchemy_getTokenBalances with specific contracts (USDC, USDT; both 6 decimals):");
  for (const t of stables.tokenBalances) {
    const sym = t.contractAddress.toLowerCase() === USDC.toLowerCase() ? "USDC" : "USDT";
    console.log(`   ${sym}: ${t.error ? `error: ${t.error}` : formatUnits(t.tokenBalance, 6)}`);
  }

  // 4) alchemy_getTokenAllowance: how much a spender (here, Uniswap V2 Router) may move on the owner's behalf.
  const allowance = await rpc("alchemy_getTokenAllowance", [{ contract: USDC, owner: WALLET, spender: UNISWAP_V2_ROUTER }]);
  console.log(`\n4) alchemy_getTokenAllowance → USDC allowance for Uniswap V2 Router: ${formatUnits(allowance, 6)} USDC`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  if (/401|403|Must be authenticated|invalid api key/i.test(err.message)) console.error("Check ALCHEMY_API_KEY in .env and that Ethereum Mainnet is enabled for your Alchemy app.");
  process.exit(1);
});
