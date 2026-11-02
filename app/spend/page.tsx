import type { Metadata } from "next";
import { SpendPage } from "@/components/spend-page";

export const metadata: Metadata = { title: "Spend · Blitz Lead Engine" };

export default function Spend() {
  return <SpendPage />;
}
