// Runs on the Postgres work queue.
//
//   createRun ─▶ runs row, then wake the workers (kick)
//   paging   ─▶ one search page ─▶ items (stage 1, ready) ┐  page + cursor in one transaction
//   workers ─▶ claim ready items of a step (SKIP LOCKED) ─▶ call the API ─▶ commit:
//                 next step (ready) │ new items (1 company → many people) │ saved row │ dropped
//
// Everything a run knows lives in the database, so any number of worker
// processes can share the work, and a crash loses at most the batch in hand.
import type { ISql } from "postgres";
import { sql } from "../pg";
import { insertRows, flatten, normUrl } from "../db";
import { STEP_BY_ID, type Item, type Rec, type StepDef } from "../steps";
import { dedupeKey, newRunId, type RunEvent, type RunOptions, type RunStats, type StageStats, type StepConfig, type StopKind } from "./common";
import { kick } from "./kick";

export type RunRow = {
  id: string; job_id: number | null; steps: StepConfig[];
  options: { concurrency: number; skipSeenPeople: boolean; skipSeenCompanies: boolean; useCache?: boolean };
  status: "running" | "draining" | "stopped" | "done" | "error";
  stop_kind: StopKind | null; stop_reason: string | null; error: string | null;
  max_items: number; max_records: number; records_used: number; saved: number;
  source_count: number; source_pages: number; source_cursor: string | null;
  source_done: boolean; source_exhausted: boolean; created_at: Date; finished_at: Date | null;
};

export const ITEM = { ready: 1, running: 2, done: 3, dropped: 4 } as const;
export const stepDef = (run: RunRow, stage: number): StepDef => STEP_BY_ID.get(run.steps[stage].step)!;
export const stepParams = (run: RunRow, stage: number): Rec => run.steps[stage].params ?? {};
const ACTIVE = ["running", "draining"];

// ── lifecycle ───────────────────────────────────────────────────────────────
export async function createRun(opts: RunOptions, extra: { jobId?: number } = {}): Promise<string> {
  const id = newRunId();
  await sql.begin(async (tx) => {
    await tx`
      insert into runs (id, job_id, steps, options, status, max_items, max_records)
      values (${id}, ${extra.jobId ?? null}, ${JSON.stringify(opts.steps)}::text::jsonb,
              ${JSON.stringify({ concurrency: opts.concurrency, skipSeenPeople: opts.skipSeenPeople, skipSeenCompanies: opts.skipSeenCompanies, useCache: opts.useCache !== false })}::text::jsonb,
              'running', ${opts.maxItems}, ${opts.maxRecords})`;
    await tx`insert into run_stages (run_id, stage) select ${id}::text, s from generate_series(0, ${opts.steps.length - 1}::int) s`;
    await addLogs(tx, id, [{ stage: "run", message: `Started: ${opts.steps.map((s) => STEP_BY_ID.get(s.step)!.label).join(" → ")} → Save` }]);
  });
  await kick("run started");
  return id;
}

export async function getRun(id: string): Promise<RunRow | undefined> {
  const [r] = await sql<RunRow[]>`select * from runs where id = ${id}`;
  return r;
}

/** The run without step settings (steps = [{ step }] only). For polling. */
export async function getRunLight(id: string): Promise<RunRow | undefined> {
  const [r] = await sql<RunRow[]>`select * from runs_light where id = ${id}`;
  return r;
}

/** Hard stop: no new work is claimed. Rows not finished yet stay in the queue (a resume continues them). */
export async function stopRun(id: string, reason = "Stop requested", kind: StopKind = "user") {
  const r = await sql`
    update runs set status = 'stopped', stop_kind = coalesce(stop_kind, ${kind}), stop_reason = coalesce(stop_reason, ${reason}),
                    source_done = true, finished_at = now()
    where id = ${id} and status in ('running', 'draining')`;
  if (r.count) await addLogs(sql, id, [{ stage: "run", message: `${reason}. No new work is started; unfinished rows wait in the queue.` }]);
}

/** Gentle stop: fetch no more search pages, but finish every row already fetched. */
export async function drainRun(tx: ISql, id: string, reason: string, kind: StopKind) {
  const r = await tx`
    update runs set status = 'draining', stop_kind = coalesce(stop_kind, ${kind}), stop_reason = coalesce(stop_reason, ${reason}), source_done = true
    where id = ${id} and status = 'running'`;
  if (r.count) await addLogs(tx, id, [{ stage: "run", message: `${reason}. Fetching no more pages; finishing the rows already found.` }]);
}

/** Continue a stopped run where it left off (optionally with a new record budget). */
export async function resumeRun(id: string, maxRecords?: number) {
  const r = await sql<RunRow[]>`
    update runs set status = 'running', stop_kind = null, stop_reason = null, error = null, finished_at = null,
                    source_done = source_exhausted or (max_items > 0 and source_count >= max_items),
                    max_records = coalesce(${maxRecords ?? null}::int, max_records)
    where id = ${id} and status in ('stopped', 'error')
    returning *`;
  if (!r.length) return;
  await addLogs(sql, id, [{ stage: "run", message: "Resumed: continuing from where it stopped" }]);
  await kick("run resumed");
  await maybeFinish(id);
}

/** Mark the run finished once the search is done and no rows are left in the queue. */
export async function maybeFinish(id: string): Promise<boolean> {
  const r = await sql<{ status: string; saved: number; records_used: number; created_at: Date }[]>`
    update runs set status = case when stop_kind is null then 'done' else 'stopped' end, finished_at = now()
    where id = ${id} and status in ('running', 'draining') and source_done
      and not exists (select 1 from items where run_id = ${id} and status in (1, 2))
    returning status, saved, records_used, created_at`;
  if (!r.length) return false;
  const secs = ((Date.now() - new Date(r[0].created_at).getTime()) / 1000).toFixed(1);
  await addLogs(sql, id, [{ stage: "run", message: `${r[0].status === "done" ? "Finished" : "Stopped"} in ${secs}s. ${r[0].saved} rows saved, ${r[0].records_used} records used` }]);
  return true;
}

export async function failRun(id: string, error: string) {
  await sql`update runs set status = 'error', error = ${error}, source_done = true, finished_at = now() where id = ${id} and status in ('running', 'draining')`;
}

// ── logs and counters ───────────────────────────────────────────────────────
export async function addLogs(tx: ISql, runId: string, logs: { stage: string; message: string }[]) {
  if (!logs.length) return;
  await tx`insert into run_logs (run_id, stage, message)
           select ${runId}::text, s, m from unnest(${logs.map((l) => l.stage)}::text[], ${logs.map((l) => l.message)}::text[]) as t(s, m)`;
}

export type Counters = Partial<Record<"received" | "done" | "out" | "duplicates" | "hits" | "errors" | "records" | "skipped" | "filtered" | "cached", number>>;
const COUNTER_KEYS = ["received", "done", "out", "duplicates", "hits", "errors", "records", "skipped", "filtered", "cached"] as const;

/** Add to the per-step counters, one statement for all steps. */
export async function bump(tx: ISql, runId: string, byStage: Map<number, Counters>) {
  const stages = [...byStage.keys()].sort((x, y) => x - y);
  if (!stages.length) return;
  // Lock the counter rows in step order first: an UPDATE ... FROM locks in no fixed order,
  // and two writers locking the same rows in different orders deadlock.
  await tx`select 1 from run_stages where run_id = ${runId} and stage = any(${stages}::int[]) order by stage for update`;
  const col = (k: (typeof COUNTER_KEYS)[number]) => stages.map((s) => byStage.get(s)![k] ?? 0);
  await tx`
    update run_stages s set
      received = s.received + u.received, done = s.done + u.done, out = s.out + u.out,
      duplicates = s.duplicates + u.duplicates, hits = s.hits + u.hits, errors = s.errors + u.errors,
      records = s.records + u.records, skipped = s.skipped + u.skipped, filtered = s.filtered + u.filtered, cached = s.cached + u.cached
    from unnest(${stages}::int[], ${col("received")}::int[], ${col("done")}::int[], ${col("out")}::int[], ${col("duplicates")}::int[],
                ${col("hits")}::int[], ${col("errors")}::int[], ${col("records")}::int[], ${col("skipped")}::int[], ${col("filtered")}::int[],
                ${col("cached")}::int[])
         as u(stage, received, done, out, duplicates, hits, errors, records, skipped, filtered, cached)
    where s.run_id = ${runId} and s.stage = u.stage`;
}
export function add(map: Map<number, Counters>, stage: number, c: Counters) {
  const cur = map.get(stage) ?? {};
  for (const [k, v] of Object.entries(c)) cur[k as keyof Counters] = (cur[k as keyof Counters] ?? 0) + (v ?? 0);
  map.set(stage, cur);
}

// ── hand-off: an item leaves a step ─────────────────────────────────────────
export type Candidate = { item: Item; id?: string }; // id = existing queue row (absent for new rows)

/**
 * Items leave step `from`: duplicate check (if that step introduces a record type),
 * then on to the next step, or saved when it was the last step. Runs inside the
 * caller's transaction together with the rest of the batch.
 *
 * Returns how many rows were saved. It never touches the runs row: the caller updates
 * it last in the transaction, so every transaction locks rows in the same order
 * (queue rows, step counters, then the run) and parallel batches can't deadlock.
 */
export async function handOff(tx: ISql, run: RunRow, from: number, cands: Candidate[], counters: Map<number, Counters>): Promise<number> {
  if (!cands.length) return 0;
  for (const c of cands) c.item.key ??= Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const def = stepDef(run, from);
  let keep = cands;
  const dropIds: string[] = [];

  const on = def.dedupeOn;
  if (on) {
    const keyed = cands.map((c) => ({ c, key: dedupeKey(c.item, on) }));
    // Sorted: parallel batches then lock keys in the same order and can't deadlock each other.
    const keys = [...new Set(keyed.map((k) => k.key).filter((k): k is string => !!k))].sort();
    // Claim keys for this run; a key someone already claimed is a duplicate (works across workers).
    const fresh = new Set(keys.length
      ? (await tx<{ key: string }[]>`
          insert into run_seen (run_id, kind, key) select ${run.id}::text, ${on}::text, k from unnest(${keys}::text[]) k
          on conflict do nothing returning key`).map((r) => r.key)
      : []);
    // Saved by an earlier run?
    const skipHistory = !def.noHistorySkip &&
      ((on === "person" && run.options.skipSeenPeople) || (on === "company" && run.options.skipSeenCompanies));
    const old = new Set(skipHistory && fresh.size
      ? (await tx<{ key: string }[]>`select key from seen where kind = ${on} and key = any(${[...fresh]}::text[])`).map((r) => r.key)
      : []);
    const taken = new Set<string>();
    keep = [];
    let dups = 0;
    for (const { c, key } of keyed) {
      if (c.item.rerun || !key || (fresh.has(key) && !old.has(key) && !taken.has(key))) {
        if (key) taken.add(key);
        keep.push(c);
      } else {
        dups++;
        if (c.id) dropIds.push(c.id);
      }
    }
    add(counters, from, { duplicates: dups });
    // Say why: otherwise a run that only finds known leads just ends with "0 rows saved".
    const known = keyed.filter(({ c, key }) => !c.item.rerun && key && old.has(key)).length;
    if (known) {
      const what = on === "person" ? "people" : "companies";
      await addLogs(tx, run.id, [{ stage: def.label, message:
        `${known} ${what} skipped: already saved by an earlier run ("Only new ${what}" is on; turn it off in the job to get them again)` }]);
    }
  }
  add(counters, from, { out: keep.length });
  if (dropIds.length) await tx`update items set status = ${ITEM.dropped}, lease_until = null, updated_at = now() where id = any(${dropIds}::bigint[])`;

  const next = from + 1;
  if (next >= run.steps.length) {
    // Last step done: save the rows (and remember the people/companies) in the same transaction.
    for (const c of keep) delete c.item.rerun;
    const rows = keep.map((c) => flatten(c.item));
    const marks = keep.flatMap((c) => [
      ...(c.item.person?.person_linkedin_url ? [{ kind: "person", key: normUrl(String(c.item.person.person_linkedin_url)) }] : []),
      ...(c.item.company?.company_linkedin_url ? [{ kind: "company", key: normUrl(String(c.item.company.company_linkedin_url)) }] : []),
    ]);
    marks.sort((a, b) => (a.kind + a.key < b.kind + b.key ? -1 : 1)); // same lock order in every batch
    await insertRows(tx, run.id, rows, marks, keep.map((c) => c.item.key ?? null));
    const ids = keep.filter((c) => c.id).map((c) => c.id!);
    if (ids.length) await tx`update items set status = ${ITEM.done}, lease_until = null, updated_at = now() where id = any(${ids}::bigint[])`;
    return rows.length;
  }
  for (const c of keep) delete c.item.rerun; // the duplicate check is skipped only once
  add(counters, next, { received: keep.length });
  const moving = keep.filter((c) => c.id);
  const born = keep.filter((c) => !c.id);
  if (moving.length) {
    await tx`
      update items set stage = ${next}, status = ${ITEM.ready}, data = u.d::jsonb, lease_until = null, attempts = 0, error = null, updated_at = now()
      from unnest(${moving.map((c) => c.id!)}::bigint[], ${moving.map((c) => JSON.stringify(c.item))}::text[]) as u(id, d)
      where items.id = u.id`;
  }
  if (born.length) {
    await tx`
      insert into items (run_id, stage, status, data)
      select ${run.id}::text, ${next}::int, ${ITEM.ready}::smallint, d::jsonb from unnest(${born.map((c) => JSON.stringify(c.item))}::text[]) as t(d)`;
  }
  return 0;
}

// ── live view ───────────────────────────────────────────────────────────────
export async function runStats(run: RunRow): Promise<RunStats> {
  const [rows, counts] = await Promise.all([
    sql<(Counters & { stage: number })[]>`select * from run_stages where run_id = ${run.id} order by stage`,
    sql<{ stage: number; status: number; n: number }[]>`
      select stage, status, count(*)::int as n from items where run_id = ${run.id} and status in (1, 2) group by 1, 2`,
  ]);
  const count = (stage: number, status: number) => counts.find((c) => c.stage === stage && c.status === status)?.n ?? 0;
  const pendingUpTo = (stage: number) => counts.some((c) => c.stage <= stage);
  const terminal = !ACTIVE.includes(run.status);
  const stages: StageStats[] = run.steps.map((s, i) => {
    const def = STEP_BY_ID.get(s.step)!;
    const c: Counters = rows.find((r) => r.stage === i) ?? {};
    const status = terminal
      ? run.status === "done" ? "done" : run.status === "error" && i === 0 ? "error" : "stopped"
      : i === 0 ? (run.source_done ? (run.stop_kind ? "stopped" : "done") : "running")
      : run.source_done && !pendingUpTo(i) ? "done" : "running";
    return {
      id: def.id, label: def.label, group: def.group, dedupe_on: def.dedupeOn ?? null, status,
      received: c.received ?? 0, waiting: count(i, ITEM.ready), in_flight: count(i, ITEM.running), done: c.done ?? 0,
      out: c.out ?? 0, duplicates: c.duplicates ?? 0, hits: c.hits ?? 0, errors: c.errors ?? 0, records: c.records ?? 0,
      skipped: c.skipped ?? 0, filtered: c.filtered ?? 0, cached: c.cached ?? 0,
    };
  });
  return { stages, saved: run.saved, records_used: run.records_used, max_records: run.max_records, failed: await failedCount(run.id) };
}

/** Everything new for a live viewer since its last poll. */
export async function pollRun(id: string, since: { log: number; row: number }): Promise<{ events: RunEvent[]; finished: boolean }> {
  const run = await getRunLight(id);
  if (!run) return { events: [{ type: "finished", status: "error", error: "Run not found" }], finished: true };
  const t0 = new Date(run.created_at).getTime();
  const [logs, rows, stats] = await Promise.all([
    sql<{ id: number; at: Date; stage: string; message: string }[]>`
      select id::int, at, stage, message from run_logs where run_id = ${id} and id > ${since.log} order by id limit 500`,
    sql<{ id: number; data: Rec }[]>`select id::int, data from rows where run_id = ${id} and id > ${since.row} order by id limit 500`,
    runStats(run),
  ]);
  const events: RunEvent[] = [{ type: "stats", stats }];
  for (const l of logs) { events.push({ type: "log", at: new Date(l.at).getTime() - t0, stage: l.stage, message: l.message }); since.log = l.id; }
  for (const r of rows) { events.push({ type: "row", row: r.data }); since.row = r.id; }
  const finished = !ACTIVE.includes(run.status) && rows.length < 500 && logs.length < 500;
  if (finished) events.push({ type: "finished", status: run.status, error: run.error ?? undefined });
  return { events, finished };
}

// ── re-run failed steps ─────────────────────────────────────────────────────
/** How many leads of a run have a failed step that hasn't been re-run yet. */
export async function failedCount(runId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(distinct coalesce(item_key, id::text))::int as n from item_failures where run_id = ${runId} and not retried`;
  return r.n;
}

/**
 * Put every lead whose step failed back into the queue at the step that failed
 * (the earliest one, if several failed), and remove its incomplete saved row.
 * The rest of the run is untouched, so nothing else is fetched or paid for again.
 */
export async function rerunFailed(runId: string): Promise<{ count: number } | { error: string }> {
  let count = 0;
  const run = await getRunLight(runId);
  if (!run) return { error: "Run not found" };
  await sql.begin(async (tx) => {
    const fails = await tx<{ stage: number; item_key: string | null; data: Item }[]>`
      update item_failures set retried = true where run_id = ${runId} and not retried returning stage, item_key, data`;
    if (!fails.length) return;
    // One re-run per lead, from its earliest failed step (later steps run again after it).
    const byKey = new Map<string, { stage: number; data: Item }>();
    for (const f of fails) {
      const k = f.item_key ?? Math.random().toString(36);
      const cur = byKey.get(k);
      if (!cur || f.stage < cur.stage) byKey.set(k, { stage: f.stage, data: f.data });
    }
    const list = [...byKey.values()];
    count = list.length;
    const keys = fails.map((f) => f.item_key).filter((k): k is string => !!k);
    const removed = keys.length ? (await tx`delete from rows where run_id = ${runId} and item_key = any(${[...new Set(keys)]}::text[])`).count : 0;
    for (const l of list) { l.data.rerun = true; delete l.data.extra?.failed_step; }
    await tx`
      insert into items (run_id, stage, status, data)
      select ${runId}::text, s, ${ITEM.ready}::smallint, d::jsonb
      from unnest(${list.map((l) => l.stage)}::int[], ${list.map((l) => JSON.stringify(l.data))}::text[]) as t(s, d)`;
    // Those rows will be processed (and counted) again.
    const perStage = new Map<number, number>();
    for (const f of fails) perStage.set(f.stage, (perStage.get(f.stage) ?? 0) + 1);
    for (const [stage, n] of perStage) {
      await tx`update run_stages set errors = greatest(errors - ${n}, 0), done = greatest(done - ${n}, 0) where run_id = ${runId} and stage = ${stage}`;
    }
    await tx`
      update runs set status = 'running', stop_kind = null, stop_reason = null, error = null, finished_at = null,
                      source_done = true, saved = greatest(saved - ${removed}, 0)
      where id = ${runId}`;
    // A finished job goes back to running for this, without counting the cycle twice.
    if (run.job_id) {
      await tx`
        update jobs set status = 'running', note = 'Re-running failed rows', error = null,
          rows = case when status = 'done' then greatest(rows - ${run.saved}, 0) else rows end,
          records_total = case when status = 'done' then greatest(records_total - ${run.records_used}, 0) else records_total end,
          cycles = case when status = 'done' then greatest(cycles - 1, 0) else cycles end
        where id = ${run.job_id} and run_id = ${runId}`;
    }
    await addLogs(tx, runId, [{ stage: "run", message: `Re-running ${count} lead(s) from the step that failed. Their old incomplete rows were removed.` }]);
  });
  if (count) await kick("re-run failed");
  return { count };
}
