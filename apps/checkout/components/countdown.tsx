"use client";

import { useEffect, useState } from "react";

function remaining(ms: number) {
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `Expires in ${Math.floor(h / 24)} days`;
  if (h >= 1) return `Expires in ${h}h ${m}m`;
  return `Expires in ${m}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function Countdown({ expiresAt }: { expiresAt: string }) {
  const target = new Date(expiresAt).getTime();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Render nothing until mounted to avoid a server/client clock mismatch.
  if (now === null) return null;
  return <span suppressHydrationWarning>{remaining(target - now)}</span>;
}
