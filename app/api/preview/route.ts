import { blitzClient } from "@/lib/runtime";
import { describeError, type StepConfig } from "@/lib/engine/common";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * How many results a search source matches: one call with max_results = 1
 * (Blitz charges 1 record for the 1 result it returns). The builder turns the
 * count into a cost estimate for the whole pipeline.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { steps?: StepConfig[] };
  const first = body.steps?.[0];
  if (!first) return json({ error: "No steps" }, 400);
  const client = blitzClient();
  const calls: Record<string, (p: any) => PromiseLike<{ response: any }>> = {
    people_search: (p) => client.search.people(p),
    company_search: (p) => client.search.companies(p),
    tam_by_jobs: (p) => client.company.tam_by_jobs(p),
    tam_by_people: (p) => client.company.tam_by_people(p),
    jobs_search: (p) => client.jobs.search(p),
  };
  const call = calls[first.step];
  if (!call) return json({ error: "Only searches need a preview call; lists are counted for free." }, 400);
  try {
    const page = await call({ ...(first.params ?? {}), max_results: 1 });
    const total = Number(page.response?.total_results ?? 0);
    return json({
      total,
      // One search stops at 50,000 results.
      usable: Math.min(total, 50_000),
      records_used: Number(page.response?.fair_usage?.records_used ?? 0),
    });
  } catch (e) {
    return json({ error: describeError(e) }, 400);
  }
}
