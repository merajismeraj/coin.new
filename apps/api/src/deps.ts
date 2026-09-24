import { RpcChainVerifier } from "@coinnew/chains/verify";
import type { Config } from "./config.js";
import { screenerFromConfig } from "./services/screening.js";

export const productionDeps = (config: Config) => ({
  verifier: new RpcChainVerifier({ network: config.network, rpcUrls: config.rpcUrls }),
  screener: screenerFromConfig(config.screening),
});
