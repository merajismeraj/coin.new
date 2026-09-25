import { createConfig, http } from "wagmi";
import { base, baseSepolia, mainnet, polygon, polygonAmoy, robinhood, robinhoodTestnet, sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

// Both networks are registered; the invoice's payment options carry the chain id to use.
const chains = [mainnet, base, polygon, robinhood, sepolia, baseSepolia, polygonAmoy, robinhoodTestnet] as const;
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains,
  ssr: true,
  connectors: [
    // Browser-extension wallets (MetaMask, Coinbase Wallet, Rabby…); mobile wallets via WalletConnect.
    injected(),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
  ],
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])) as never,
});

export const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  (process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
