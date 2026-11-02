import { exportResponse, filterFromQuery } from "@/lib/leads";

export const dynamic = "force-dynamic";
// Direct downloads stream for up to 300 s (the most Vercel Hobby allows; Pro could go to 800). Huge ones use /api/exports.
export const maxDuration = 300;

/** Download the leads matching the same filters as the grid. ?fmt=csv|xlsx */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return exportResponse(filterFromQuery(p), "leads", p.get("fmt"));
}
