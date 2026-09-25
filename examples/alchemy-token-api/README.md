# Alchemy Token API demo

Ethereum Mainnet. Uses `alchemy_getTokenBalances`, `alchemy_getTokenMetadata` and
`alchemy_getTokenAllowance` over JSON-RPC with Node's built-in `fetch`.

```bash
npm install
cp .env.example .env        # then put your key in .env: ALCHEMY_API_KEY=...
npm run demo                # default wallet: vitalik.eth
node demo-script.js 0xYourAddress
```

The key is read from `process.env.ALCHEMY_API_KEY` (via dotenv) and never hard-coded.
`.env` is git-ignored.
