import { redirect } from "next/navigation";

// Checkout serves /i/:id links; anything else goes to the storefront.
export default function Home() {
  redirect(process.env.STOREFRONT_URL ?? "https://coin.new");
}
