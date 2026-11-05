import { runtime } from "@/lib/runtime";
import { recentAlerts, createJob, schedulerSettings, spentToday, JOBS_DIR } from "@/lib/jobs";
import { validateSteps, type RunOptions } from "@/lib/engine/common";
import { clamp, json } from "@/lib/http";
import { sql } from "@/lib/pg";
import { STEP_BY_ID, type Rec } from "@/lib/steps";

export const dynamic = "force-dynamic";

export async function GET() {
  const { scheduler } = runtime();
  // Independent lookups at the same time: the Jobs page polls this every 2 seconds.
  const [jobs, settings, spent_today, alerts, beat] = await Promise.all([
    scheduler.view(),
    schedulerSettings(),
    spentToday(),
    recentAlerts(),
    // EXECUTION=worker: the separate worker's last heartbeat (null = it never ran)
    process.env.EXECUTION === "worker" ? sql<{ value: string }[]>`select value from settings where key = 'worker_heartbeat'` : Promise.resolve(null),
  ]);
  return json({
    jobs: jobs.map((j) => ({ ...j, steps: j.steps.map((id) => STEP_BY_ID.get(id)?.label ?? id) })), // step names, not ids
    settings, spent_today,
    running: jobs.filter((j) => j.live).length,
    alerts,
    jobs_dir: JOBS_DIR,
    worker_seen: beat ? beat[0]?.value ?? null : undefined,
  });
}

/** "Save as job" in the builder: stores the job in the database and queues it. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Rec;
  const steps = Array.isArray(b.steps) ? (b.steps as RunOptions["steps"]) : [];
  const err = validateSteps(steps);
  if (err) return json({ error: err }, 400);
  const name = String(b.name ?? "").trim();
  if (!name) return json({ error: "Give the job a name" }, 400);
  const created = await createJob(name, {
    steps,
    batch_size: clamp(b.batch_size, 1000, 1, 50_000),
    record_budget: clamp(b.record_budget, 5000, 1, 100_000_000),
    workers: clamp(b.workers, 20, 1, 50),
    skip_seen_people: b.skip_seen_people !== false,
    skip_seen_companies: b.skip_seen_companies === true,
    use_cache: b.use_cache !== false,
    max_results: Number(b.max_results) > 0 ? Math.floor(Number(b.max_results)) : 0,
    ...(Number(b.repeat_every_hours) > 0 ? { repeat_every_hours: Number(b.repeat_every_hours) } : {}),
  });
  if ("error" in created) return json({ error: created.error }, 400);
  void runtime().scheduler.tick();
  return json({ key: created.key });
}
