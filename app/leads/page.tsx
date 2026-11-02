import type { Metadata } from "next";
import { LeadsPage } from "@/components/leads-page";

export const metadata: Metadata = { title: "Leads · Blitz Lead Engine" };

export default function Leads() {
  return <LeadsPage />;
}
