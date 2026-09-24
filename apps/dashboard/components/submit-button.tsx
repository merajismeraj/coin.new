"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./ui";

export function SubmitButton({ children, pendingText, variant }: { children: React.ReactNode; pendingText?: string; variant?: "primary" | "secondary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={variant}>
      {pending ? (pendingText ?? "Working…") : children}
    </Button>
  );
}
