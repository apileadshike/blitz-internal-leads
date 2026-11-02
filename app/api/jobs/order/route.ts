import { runtime } from "@/lib/runtime";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown[] };
  const { scheduler } = runtime();
  await scheduler.reorder(Array.isArray(body.ids) ? body.ids.map(Number) : []);
  void scheduler.tick();
  return Response.json({ ok: true });
}
