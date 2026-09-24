/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@coinnew/shared-types", "@coinnew/chains"],
  poweredByHeader: false,
  webpack: (config) => {
    // wagmi's connector barrel references SDKs for connectors we don't use
    // (Base Account / Coinbase CDP). Stub them out so they never ship to buyers.
    config.resolve.alias = { ...config.resolve.alias, "@base-org/account": false, "@coinbase/wallet-sdk": false, "@coinbase/cdp-sdk": false };
    // Optional peer deps of WalletConnect/pino that aren't needed in the browser.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};
export default nextConfig;
