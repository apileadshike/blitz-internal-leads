import { rerunFailed } from "@/lib/engine/runs";
import { json } from "@/lib/http";

/** Put a run's failed leads back into the queue at the step that failed. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await rerunFailed((await params).id);
  return "error" in r ? json(r, 404) : json(r);
}
