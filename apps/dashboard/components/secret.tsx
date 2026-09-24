"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";
import { Button } from "./ui";

export function RevealSecret({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">
        {shown ? value : `whsec_${"•".repeat(24)}`}
      </code>
      <Button type="button" variant="secondary" onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Reveal"}</Button>
      <CopyButton value={value} />
    </div>
  );
}
