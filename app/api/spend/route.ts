import { sql } from "@/lib/pg";
import { STEP_BY_ID } from "@/lib/steps";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Where the records went: per day, per step and per job, with lookups, hits and
 * errors (from the per-step counters every run keeps). ?days=30
 */
export async function GET(req: Request) {
  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 30) || 30));
  const since = sql`r.created_at >= now() - make_interval(days => ${days})`;
  const [byDay, byStep, byJob, [totals]] = await Promise.all([
    sql<{ day: string; records: number; done: number; hits: number; errors: number; saved: number; runs: number }[]>`
      with st as (
        select to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD') as day,
               sum(s.records)::int as records, sum(s.done)::int as done, sum(s.hits)::int as hits, sum(s.errors)::int as errors
        from run_stages s join runs r on r.id = s.run_id
        where ${since} group by 1
      ), rn as (
        select to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD') as day, sum(r.saved)::int as saved, count(*)::int as runs
        from runs r where ${since} group by 1
      )
      select rn.day, coalesce(st.records, 0) as records, coalesce(st.done, 0) as done, coalesce(st.hits, 0) as hits,
             coalesce(st.errors, 0) as errors, rn.saved, rn.runs
      from rn left join st on st.day = rn.day
      order by rn.day desc`,
    sql<{ step: string; records: number; done: number; hits: number; errors: number; cached: number }[]>`
      select r.steps->s.stage->>'step' as step,
             sum(s.records)::int as records, sum(s.done)::int as done, sum(s.hits)::int as hits, sum(s.errors)::int as errors,
             sum(s.cached)::int as cached
      from run_stages s join runs r on r.id = s.run_id
      where ${since}
      group by 1 order by 2 desc`,
    sql<{ job_id: number | null; name: string | null; records: number; saved: number; runs: number }[]>`
      select r.job_id, j.name, sum(r.records_used)::int as records, sum(r.saved)::int as saved, count(*)::int as runs
      from runs r left join jobs j on j.id = r.job_id
      where ${since}
      group by 1, 2 order by 3 desc`,
    sql<{ today: number; week: number; period: number }[]>`
      select
        coalesce(sum(records_used) filter (where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'), 0)::int as today,
        coalesce(sum(records_used) filter (where created_at >= now() - interval '7 days'), 0)::int as week,
        coalesce(sum(records_used), 0)::int as period
      from runs r where ${since}`,
  ]);
  return json({
    days, totals,
    byDay,
    byStep: byStep.map((s) => ({ ...s, label: STEP_BY_ID.get(s.step)?.label ?? s.step })),
    byJob: byJob.map((j) => ({ ...j, name: j.job_id ? (j.name ?? `Deleted job #${j.job_id}`) : "Builder runs (not jobs)" })),
  });
}
