"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { SOLANA_RPC_URL, wagmiConfig } from "@/lib/wagmi";

/** Wallet connectivity for the buyer. Everything is signed in the buyer's own wallet. */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {/* Wallet Standard wallets (Phantom, Solflare, Backpack…) are detected automatically. */}
        <ConnectionProvider endpoint={SOLANA_RPC_URL}>
          <WalletProvider wallets={[]} autoConnect>
            {children}
          </WalletProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
