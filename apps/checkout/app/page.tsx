import { notFound } from "next/navigation";

// Checkout only serves /i/:id links.
export default function Home() {
  notFound();
}
