import { createRun } from "@/lib/engine/runs";
import { validateSteps, type RunOptions } from "@/lib/engine/common";
import { clamp, json } from "@/lib/http";

/** Start a manual run from the builder. The work goes onto the Postgres queue. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Partial<RunOptions>;
  const steps = Array.isArray(b.steps) ? b.steps : [];
  const err = validateSteps(steps);
  if (err) return json({ error: err }, 400);
  const id = await createRun({
    steps,
    // 0 = everything the filter matches (Blitz stops a single search at 50,000)
    maxItems: b.maxItems === 0 ? 0 : clamp(b.maxItems, 20, 1, 50_000),
    concurrency: clamp(b.concurrency, 20, 1, 50),
    maxRecords: clamp(b.maxRecords, 1000, 1, 10_000_000),
    skipSeenPeople: b.skipSeenPeople !== false,
    skipSeenCompanies: b.skipSeenCompanies === true,
    useCache: b.useCache !== false,
  });
  return json({ id });
}
