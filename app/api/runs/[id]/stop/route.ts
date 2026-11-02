import { stopRun } from "@/lib/engine/runs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await stopRun((await params).id);
  return Response.json({ ok: true });
}
