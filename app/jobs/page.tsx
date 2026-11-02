import type { Metadata } from "next";
import { JobsPage } from "@/components/jobs-page";

export const metadata: Metadata = { title: "Jobs · Blitz Lead Engine" };

export default function Jobs() {
  return <JobsPage />;
}
