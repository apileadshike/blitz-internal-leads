import { filterFromQuery } from "@/lib/leads";
import { startExport, storageEnabled } from "@/lib/exports";
import { json } from "@/lib/http";

/** Start a background export of the leads matching ?<same filters as the grid>&fmt=csv|xlsx → { id }. */
export async function POST(req: Request) {
  if (!storageEnabled()) return json({ error: "Background exports need SUPABASE_SECRET_KEY (see .env.example)." }, 400);
  const p = new URL(req.url).searchParams;
  const fmt = p.get("fmt") === "xlsx" ? "xlsx" : "csv";
  const id = await startExport(filterFromQuery(p), fmt, p.get("name") || "leads");
  return json({ id });
}
