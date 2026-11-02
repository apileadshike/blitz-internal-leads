import { exportResponse } from "@/lib/leads";

export const dynamic = "force-dynamic";
// Direct downloads stream for as long as the host allows (Vercel Pro: up to 800 s). Huge ones use /api/exports.
export const maxDuration = 800;

/** One run's rows, streamed. ?fmt=csv (default) or ?fmt=xlsx */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return exportResponse({ runIds: [id] }, `leads-${id}`, new URL(req.url).searchParams.get("fmt"));
}
