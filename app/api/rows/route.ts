import { exportResponse } from "@/lib/leads";

export const dynamic = "force-dynamic";
// Direct downloads stream for up to 300 s (the most Vercel Hobby allows; Pro could go to 800). Huge ones use /api/exports.
export const maxDuration = 300;

/** Every saved row, streamed. ?fmt=csv (default) or ?fmt=xlsx */
export async function GET(req: Request) {
  return exportResponse({}, "all-leads", new URL(req.url).searchParams.get("fmt"));
}
