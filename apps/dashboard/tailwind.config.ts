import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"], mono: ["ui-monospace", "SFMono-Regular", "monospace"] },
      colors: { brand: { DEFAULT: "#1d4ed8", fg: "#ffffff" } },
    },
  },
  plugins: [],
} satisfies Config;
