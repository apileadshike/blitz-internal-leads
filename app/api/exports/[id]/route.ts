import { exportStatus } from "@/lib/exports";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** { status: queued | running | done | failed, rows, url (when done) } */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await exportStatus((await params).id);
  return s ? json(s) : json({ error: "Export not found" }, 404);
}
