import { exportResponse, filterFromQuery } from "@/lib/leads";

export const dynamic = "force-dynamic";
// Direct downloads stream for as long as the host allows (Vercel Pro: up to 800 s). Huge ones use /api/exports.
export const maxDuration = 800;

/** Download the leads matching the same filters as the grid. ?fmt=csv|xlsx */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return exportResponse(filterFromQuery(p), "leads", p.get("fmt"));
}
