// Worker: pulls work from Postgres and does it.
//
//   • Step work: claims a batch of ready items for one step with FOR UPDATE SKIP LOCKED
//     (so many workers never get the same row), calls the API for each, then commits
//     the whole batch in one transaction. A lease (renewed while working) means a
//     crashed worker's rows go back to the queue by themselves.
//   • Search paging: a worker claims a run's paging with a lease on the run, fetches
//     pages and commits each page together with its cursor, so a crash re-buys at most one page.
//   • Reaper: puts expired leases back, finishes runs, cleans up old queue rows.
//
// Where it runs:
//   • start(): forever, inside the web server or `npm run worker` (local / own server)
//   • drain(): until the queue is empty, inside a Trigger.dev task (src/trigger/queue.ts)
import { AuthenticationError, InsufficientRecordsError, APIStatusError, type BlitzAPI } from "blitz-api-js";
import type { ISql } from "postgres";
import { sql } from "../pg";
import type { Item, StepCtx } from "../steps";
import { describeError, hasInput, isTransient } from "./common";
import { cacheEnabled, cachedClient, pruneCache } from "./cache";
import { deleteFiles, type Store } from "../storage";
import {
  ITEM, add, addLogs, bump, drainRun, failRun, getRun, handOff, maybeFinish, stepDef, stepParams, stopRun,
  type Candidate, type Counters, type RunRow,
} from "./runs";

const LEASE_SECONDS = 120;
const BACKLOG_LIMIT = 1000; // stop fetching pages while this many rows wait (spend follows progress)
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isFatal = (e: unknown) => e instanceof InsufficientRecordsError || e instanceof AuthenticationError;
const today = () => new Date().toISOString().slice(0, 10);

type Claimed = { id: string; data: Item; attempts: number };

/** Run fn over items with at most `limit` at a time. */
async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Most records one result of step 1 can still cost in the steps after it: a paid lookup
 * per lead, and an expand step (Waterfall, Employee Finder…) multiplying the leads after it.
 */
function laterCostPerResult(run: RunRow): number {
  let mult = 1, cost = 0;
  for (let i = 1; i < run.steps.length; i++) {
    const def = stepDef(run, i);
    const p = stepParams(run, i);
    if (def.group === "expand") {
      const per = Number(p.max_results ?? (p.per_role ? Number(p.per_role) * 3 : 1)) || 1;
      cost += mult * per;
      mult *= per;
    } else if (/^POST /.test(def.endpoint)) cost += mult;
  }
  return cost;
}

export class Worker {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private reaper?: NodeJS.Timeout;
  private runs = new Map<string, RunRow>();
  private steps = new Map<string, RunRow["steps"]>();
  private runsAt = 0;
  private candidates: { run_id: string; stage: number }[] = [];
  private busy = new Map<string, number>();
  private logged = new Set<string>();
  private dailyCache = { at: 0, budget: Infinity, spent: 0 };
  private turn = 0;
  private lastWorkAt = Date.now();
  private sourceSlots = Number(process.env.SOURCE_CONCURRENCY ?? 2);

  constructor(private client: BlitzAPI, private slots = Number(process.env.WORKER_SLOTS ?? 6)) {}

  /** Work forever (web server / `npm run worker`). */
  async start() {
    this.launch();
    this.reaper = setInterval(() => void this.reap(), 20_000);
    void this.reap();
    console.log(`[worker] started: ${this.slots} step slots, ${this.sourceSlots} paging slots`);
  }

  /**
   * Work until the queue has been empty for `idleMs`, or `maxMs` has passed (Trigger.dev tasks).
   * Returns true if work is still waiting (the caller then starts another drain).
   */
  async drain({ idleMs = 15_000, maxMs = 10 * 60_000 } = {}): Promise<boolean> {
    const t0 = Date.now();
    await this.reap();
    this.lastWorkAt = Date.now();
    this.launch();
    while (Date.now() - this.lastWorkAt < idleMs && Date.now() - t0 < maxMs) await sleep(1000);
    await this.shutdown();
    return hasPendingWork();
  }

  private launch() {
    this.stopping = false;
    this.loops = [
      ...Array.from({ length: this.slots }, () => this.loop(() => this.step())),
      ...Array.from({ length: this.sourceSlots }, () => this.loop(() => this.pageStep())),
    ];
  }

  /** Finish batches in hand, then stop. Unfinished rows stay in the queue for the next start. */
  async shutdown(ms = 20_000) {
    this.stopping = true;
    clearInterval(this.reaper);
    await Promise.race([Promise.all(this.loops), sleep(ms)]);
  }

  // ── what to work on ───────────────────────────────────────────────────────
  private async refresh() {
    if (Date.now() - this.runsAt < 1000) return;
    this.runsAt = Date.now();
    // Step settings never change during a run and can be large (imported lists): fetch them once per run.
    const runs = await sql<RunRow[]>`select * from runs_light where status in ('running', 'draining')`;
    const missing = runs.filter((r) => !this.steps.has(r.id)).map((r) => r.id);
    if (missing.length) {
      for (const r of await sql<{ id: string; steps: RunRow["steps"] }[]>`select id, steps from runs where id = any(${missing}::text[])`) this.steps.set(r.id, r.steps);
    }
    for (const id of this.steps.keys()) if (!runs.some((r) => r.id === id)) this.steps.delete(id);
    for (const r of runs) r.steps = this.steps.get(r.id) ?? r.steps;
    this.runs = new Map(runs.map((r) => [r.id, r]));
    this.candidates = runs.length
      ? await sql<{ run_id: string; stage: number }[]>`
          select distinct run_id, stage from items
          where status = 1 and (lease_until is null or lease_until < now()) and run_id = any(${runs.map((r) => r.id)}::text[])`
      : [];
  }
  private isStopped = (runId: string) => this.stopping || !this.runs.has(runId);

  private async loop(work: () => Promise<boolean>) {
    while (!this.stopping) {
      let worked = false;
      try { worked = await work(); } catch (e) {
        console.error("[worker]", describeError(e));
        await sleep(2000);
      }
      if (worked) this.lastWorkAt = Date.now();
      else await sleep(500);
    }
  }

  /** Claim one run's search paging (a lease on the run, so only one worker pages it) and fetch pages. */
  private async pageStep(): Promise<boolean> {
    const [run] = await sql<{ id: string }[]>`
      update runs set source_lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
      where id = (
        select id from runs
        where status = 'running' and not source_done and (source_lease_until is null or source_lease_until < now())
          and (select count(*) from (select 1 from items where run_id = runs.id and status = 1 limit ${BACKLOG_LIMIT}) b) < ${BACKLOG_LIMIT}
        order by created_at limit 1
        for update skip locked
      )
      returning id`;
    if (!run) return false;
    let pauseSecs = 0;
    try {
      pauseSecs = await this.sourceJob(run.id);
    } finally {
      // Release the paging lease (or keep it a while after a temporary error, as a back-off).
      await sql`update runs set source_lease_until = now() + make_interval(secs => ${pauseSecs}) where id = ${run.id}`.catch(() => {});
    }
    return true;
  }

  /** Claim and process one batch. Later steps first, so rows finish before new ones start. */
  private async step(): Promise<boolean> {
    await this.refresh();
    const runIds = [...new Set(this.candidates.map((c) => c.run_id))];
    const first = runIds[this.turn++ % Math.max(1, runIds.length)]; // take turns between runs
    const cands = [...this.candidates].sort((a, b) => Number(b.run_id === first) - Number(a.run_id === first) || b.stage - a.stage);
    for (const c of cands) {
      const run = this.runs.get(c.run_id);
      if (!run) continue;
      const def = stepDef(run, c.stage);
      const key = `${run.id}:${c.stage}`;
      if ((this.busy.get(key) ?? 0) >= (def.maxConcurrency ? 1 : 2)) continue;
      this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
      try {
        const size = Math.max(5, Math.min(100, run.options.concurrency));
        const claimed = await sql<Claimed[]>`
          with c as (
            select id from items
            where run_id = ${run.id} and stage = ${c.stage} and status = 1 and (lease_until is null or lease_until < now())
            order by id limit ${size}
            for update skip locked
          )
          update items i set status = 2, lease_until = now() + make_interval(secs => ${LEASE_SECONDS}), attempts = i.attempts + 1, updated_at = now()
          from c where i.id = c.id
          returning i.id::text as id, i.data, i.attempts`;
        if (!claimed.length) {
          this.candidates = this.candidates.filter((x) => x !== c);
          continue;
        }
        await this.processBatch(run, c.stage, claimed);
        return true;
      } finally {
        this.busy.set(key, (this.busy.get(key) ?? 1) - 1);
      }
    }
    return false;
  }

  /** The Blitz client for a step: through the cache unless the run asked for fresh data or the step needs it. */
  private lookupClient(run: RunRow, noCache: boolean | undefined, counter: { hits: number }) {
    return cacheEnabled() && run.options.useCache !== false && !noCache ? cachedClient(this.client, counter) : this.client;
  }

  // ── one batch of one step ─────────────────────────────────────────────────
  private async processBatch(run: RunRow, stage: number, claimed: Claimed[]) {
    const def = stepDef(run, stage);
    const params = stepParams(run, stage);
    const c: Counters = { done: 0, hits: 0, errors: 0, records: 0, skipped: 0, filtered: 0 };
    const fromCache = { hits: 0 };
    const logs: { stage: string; message: string }[] = [];
    const logOnce = (m: string) => {
      const k = `${run.id}:${stage}:${m}`;
      if (this.logged.has(k)) return;
      this.logged.add(k);
      logs.push({ stage: def.label, message: m });
    };
    let fatal: string | undefined;
    const ctx: StepCtx = {
      client: this.lookupClient(run, def.noCache, fromCache),
      stopped: () => !!fatal || this.isStopped(run.id),
      charge: (resp) => { c.records! += Number((resp as { fair_usage?: { records_used?: number } })?.fair_usage?.records_used ?? 0); },
      hit: () => { c.hits!++; },
      log: logOnce,
      maxItems: Infinity,
      concurrency: run.options.concurrency,
      saveCursor() {},
    };
    const ids = claimed.map((x) => x.id);
    const heartbeat = setInterval(() => {
      void sql`update items set lease_until = now() + make_interval(secs => ${LEASE_SECONDS}) where id = any(${ids}::bigint[]) and status = 2`.catch(() => {});
    }, 30_000);

    const pass: Candidate[] = [];
    const consumed: string[] = [], dropped: string[] = [], release: string[] = [];
    const retry: { id: string; secs: number; error: string }[] = [];
    const failures: { key: string | null; data: Item; error: string }[] = [];
    try {
      await mapLimit(claimed, Math.min(run.options.concurrency, def.maxConcurrency ?? Infinity), async (x) => {
        const item = x.data;
        if (fatal || this.isStopped(run.id)) return void release.push(x.id);
        const before = structuredClone(item); // what this step was given (for "Re-run failed")
        // Row lacks what this step needs (e.g. a company where no person was found): pass it on untouched.
        if (def.needs && !hasInput(item, def.needs)) { c.skipped!++; c.done!++; pass.push({ item, id: x.id }); return; }
        try {
          if (def.enrich) {
            const keep = await def.enrich(item, params, ctx);
            c.done!++;
            if (keep === false) { c.filtered!++; dropped.push(x.id); } else pass.push({ item, id: x.id });
          } else {
            const kids: Item[] = [];
            for await (const k of def.expand!(item, params, ctx)) kids.push(k);
            c.done!++;
            if (!kids.length) pass.push({ item, id: x.id }); // keep the parent row (e.g. company with no matching people)
            else { consumed.push(x.id); kids.forEach((k) => pass.push({ item: k })); }
          }
        } catch (e) {
          const msg = describeError(e);
          if (isFatal(e)) { fatal ??= `Fatal API error: ${msg}`; release.push(x.id); return; }
          if (isTransient(e) && x.attempts < MAX_ATTEMPTS) { retry.push({ id: x.id, secs: 30 * x.attempts, error: msg }); return; }
          c.errors!++; c.done!++;
          // Remember the failure so it can be re-run later, and mark the row so it's visible in the results.
          failures.push({ key: before.key ?? null, data: before, error: msg });
          item.extra.failed_step = [item.extra.failed_step, `${def.label}: ${msg}`].filter(Boolean).join("; ");
          logOnce(`Error: ${msg}${e instanceof APIStatusError && e.status_code === 422 ? " (check this step's settings; further identical errors are counted, not logged)" : ""}`);
          pass.push({ item, id: x.id }); // keep the row even if this step failed
        }
      });
    } finally {
      clearInterval(heartbeat);
    }

    c.cached = fromCache.hits;
    const counters = new Map<number, Counters>();
    add(counters, stage, c);
    await sql.begin(async (tx) => {
      await handOff(tx, run, stage, pass, counters);
      if (consumed.length) await tx`update items set status = ${ITEM.done}, lease_until = null, updated_at = now() where id = any(${consumed}::bigint[])`;
      if (dropped.length) await tx`update items set status = ${ITEM.dropped}, lease_until = null, updated_at = now() where id = any(${dropped}::bigint[])`;
      if (retry.length) {
        await tx`
          update items set status = ${ITEM.ready}, lease_until = now() + make_interval(secs => u.secs), error = u.e, updated_at = now()
          from unnest(${retry.map((r) => r.id)}::bigint[], ${retry.map((r) => r.secs)}::int[], ${retry.map((r) => r.error)}::text[]) as u(id, secs, e)
          where items.id = u.id`;
      }
      if (release.length) {
        await tx`update items set status = ${ITEM.ready}, lease_until = null, attempts = greatest(attempts - 1, 0), updated_at = now() where id = any(${release}::bigint[])`;
      }
      if (failures.length) {
        await tx`
          insert into item_failures (run_id, stage, item_key, data, error)
          select ${run.id}::text, ${stage}::int, k, d::jsonb, e
          from unnest(${failures.map((f) => f.key)}::text[], ${failures.map((f) => JSON.stringify(f.data))}::text[], ${failures.map((f) => f.error)}::text[]) as t(k, d, e)`;
      }
      await bump(tx, run.id, counters);
      await this.charge(tx, run, c.records!);
      await addLogs(tx, run.id, logs);
    });
    if (fatal) await stopRun(run.id, fatal, "fatal");
    await this.checkBudgets(run.id, c.records!);
    await maybeFinish(run.id);
  }

  private async charge(tx: ISql, run: RunRow, records: number) {
    if (!records) return;
    await tx`update runs set records_used = records_used + ${records} where id = ${run.id}`;
    // Job runs count toward the daily budget.
    if (run.job_id) await tx`insert into usage (day, records) values (${today()}, ${records}) on conflict (day) do update set records = usage.records + excluded.records`;
  }

  /** Over budget → stop fetching new pages (rows already bought still get finished). */
  private async checkBudgets(runId: string, records: number) {
    if (!records) return;
    const [r] = await sql<{ records_used: number; max_records: number; job_id: number | null }[]>`
      select records_used, max_records, job_id from runs where id = ${runId} and status in ('running', 'draining')`;
    if (!r) return;
    // The record budget is a ceiling: at it, every call for this run stops. Leads not finished
    // stay in the queue, so raising the budget and resuming continues them.
    if (r.records_used >= r.max_records) await stopRun(runId, `Record budget of ${r.max_records.toLocaleString()} reached`, "budget");
    else if (r.job_id) {
      const d = await this.daily();
      if (d.spent >= d.budget) await drainRun(sql, runId, "Daily record budget reached", "daily");
    }
  }
  private async daily() {
    if (Date.now() - this.dailyCache.at > 3000) {
      const [s] = await sql<{ budget: string | null; spent: number | null }[]>`
        select (select value from settings where key = 'daily_budget') as budget, (select records from usage where day = ${today()}) as spent`;
      this.dailyCache = { at: Date.now(), budget: Number(s.budget ?? process.env.DAILY_RECORD_BUDGET ?? 20000), spent: s.spent ?? 0 };
    }
    return this.dailyCache;
  }

  // ── search paging (this worker holds the run's paging lease) ──────────────
  private sourceErrors = new Map<string, number>();

  /** Fetch pages until the search is done, the queue is full enough, or we stop. Returns a back-off in seconds (0 = none). */
  private async sourceJob(runId: string): Promise<number> {
    while (!this.stopping) {
      const run = await getRun(runId);
      if (!run || run.status !== "running" || run.source_done) return 0;
      // Don't race ahead of the steps: spending should follow progress.
      const [{ backlog }] = await sql<{ backlog: number }[]>`
        select count(*)::int as backlog from (select 1 from items where run_id = ${runId} and status = 1 limit ${BACKLOG_LIMIT}) x`;
      if (backlog >= BACKLOG_LIMIT) return 0;
      await sql`update runs set source_lease_until = now() + make_interval(secs => ${LEASE_SECONDS}) where id = ${runId}`;

      const def = stepDef(run, 0);
      let remaining = run.max_items > 0 ? run.max_items - run.source_count : Infinity;
      // Budget-aware paging: each fetched result will still need its later steps (email, phone…).
      // Keep that money aside for the leads already queued, and fetch only what the rest can finish.
      const later = laterCostPerResult(run);
      const firstCost = /^POST /.test(def.endpoint) ? 1 : 0;
      if (later + firstCost > 0) {
        const [{ open }] = await sql<{ open: number }[]>`select count(*)::int as open from items where run_id = ${runId} and status in (1, 2)`;
        const left = run.max_records - run.records_used - open * later;
        const affordable = Math.floor(left / (later + firstCost));
        if (affordable <= 0) {
          await addLogs(sql, runId, [{ stage: def.label, message: `Fetching no more: the rest of the record budget (${Math.max(0, run.max_records - run.records_used).toLocaleString()}) is kept for the ${open.toLocaleString()} leads already found` }]);
          await sql`update runs set source_done = true where id = ${runId}`;
          await maybeFinish(runId);
          return 0;
        }
        remaining = Math.min(remaining, affordable);
      }
      const logs: { stage: string; message: string }[] = [];
      const items: Item[] = [];
      let records = 0, paged = false;
      let cursor: string | null = null;
      const fromCache = { hits: 0 };
      const ctx: StepCtx = {
        client: this.lookupClient(run, def.noCache, fromCache),
        stopped: () => paged || this.stopping, // one page per pass
        charge: (resp) => { records += Number((resp as { fair_usage?: { records_used?: number } })?.fair_usage?.records_used ?? 0); },
        hit() {},
        log: (m) => logs.push({ stage: def.label, message: m }),
        maxItems: remaining,
        concurrency: run.options.concurrency,
        startCursor: run.source_cursor ?? undefined,
        pagesDone: run.source_pages,
        saveCursor: (c) => { cursor = c; paged = true; },
      };
      if (remaining > 0) {
        try {
          for await (const it of def.source!(stepParams(run, 0), ctx)) items.push(it);
        } catch (e) {
          const msg = describeError(e);
          if (isFatal(e)) { await stopRun(runId, `Fatal API error: ${msg}`, "fatal"); return 0; }
          const tries = (this.sourceErrors.get(runId) ?? 0) + 1;
          this.sourceErrors.set(runId, tries);
          if (isTransient(e) && tries <= 5) {
            const wait = 15 * 2 ** (tries - 1); // 15s, 30s, 60s, 2m, 4m
            await addLogs(sql, runId, [{ stage: def.label, message: `Temporary error, retrying in ${wait}s: ${msg}` }]);
            return wait;
          }
          await addLogs(sql, runId, [{ stage: def.label, message: `Failed: ${msg}` }]);
          await failRun(runId, msg);
          return 0;
        }
      }
      this.sourceErrors.delete(runId);
      // A pasted-list source has no pages: it's read in one go.
      const exhausted = remaining > 0 && (!paged || cursor === null || items.length === 0);
      const finished = exhausted || remaining - items.length <= 0;
      const total = run.source_count + items.length;
      if (finished) logs.push({ stage: def.label, message: exhausted ? `Search finished: ${total.toLocaleString()} results` : `Reached the limit of ${total.toLocaleString()} results` });

      let kept = true;
      await sql.begin(async (tx) => {
        const [locked] = await tx<{ status: string }[]>`select status from runs where id = ${runId} for update`;
        if (!locked || !["running", "draining"].includes(locked.status)) { kept = false; return; }
        const counters = new Map<number, Counters>();
        add(counters, 0, { received: items.length, done: items.length, records, cached: fromCache.hits });
        await handOff(tx, run, 0, items.map((item) => ({ item })), counters);
        await bump(tx, runId, counters);
        await tx`
          update runs set source_cursor = ${paged ? cursor : run.source_cursor}, source_count = source_count + ${items.length},
                          source_pages = source_pages + ${paged ? 1 : 0}, source_done = source_done or ${finished},
                          source_exhausted = source_exhausted or ${exhausted}
          where id = ${runId}`;
        await this.charge(tx, run, records);
        await addLogs(tx, runId, logs);
      });
      this.lastWorkAt = Date.now();
      if (!kept) {
        // The run was stopped while this page was being fetched: those results were paid for but not kept.
        if (records) {
          await sql`update runs set records_used = records_used + ${records} where id = ${runId}`;
          await sql`update run_stages set records = records + ${records} where run_id = ${runId} and stage = 0`;
        }
        return 0;
      }
      await this.checkBudgets(runId, records);
      await maybeFinish(runId);
      if (finished) return 0;
    }
    return 0;
  }

  // ── housekeeping ──────────────────────────────────────────────────────────
  /** Expired leases back to the queue, finish runs, clean up. Called on a timer and by the Trigger.dev cron. */
  async reap() {
    try {
      // Rows held by a worker that died go back to the queue.
      const back = await sql`update items set status = 1, lease_until = null where status = 2 and lease_until < now()`;
      if (back.count) console.log(`[worker] ${back.count} rows from an expired lease went back to the queue`);
      const active = await sql<{ id: string; source_done: boolean; status: string }[]>`select id, source_done, status from runs where status in ('running', 'draining')`;
      for (const r of active) {
        await maybeFinish(r.id);
      }
      await pruneCache();
      await sql`delete from alerts where at < now() - interval '30 days'`;
      // Imported lists nobody uses any more (no job, no unfinished run points to them).
      const oldUploads = await sql<{ object_key: string | null }[]>`
        with old as (
          select u.id from uploads u
          where u.created_at < now() - interval '30 days'
            and not exists (select 1 from jobs j where j.steps->0->'params'->>'upload_id' = u.id)
            and not exists (select 1 from runs r where r.status <> 'done' and r.steps->0->'params'->>'upload_id' = u.id)
        ), gone as (delete from upload_rows where upload_id in (select id from old))
        delete from uploads where id in (select id from old) returning object_key`;
      await deleteFiles(oldUploads.flatMap((u) => (u.object_key ? [u.object_key] : [])), "r2");
      // Export files: download links last an hour, so files older than a week are only taking space.
      const oldExports = await sql<{ path: string | null; store: Store | null }[]>`
        delete from exports where created_at < now() - interval '7 days' returning path, store`;
      for (const store of ["r2", "supabase"] as const)
        await deleteFiles(oldExports.flatMap((x) => (x.path && (x.store ?? "supabase") === store ? [x.path] : [])), store);
      // Finished runs don't need their queue rows any more (saved leads are in "rows").
      await sql`
        with old as (select id from runs where status = 'done' and finished_at < now() - interval '3 days')
        delete from items where run_id in (select id from old)`;
    } catch (e) {
      console.error("[worker] reaper:", describeError(e));
    }
  }
}

/** Is anything waiting for a worker? (rows to process, or a search to page through) */
export async function hasPendingWork(): Promise<boolean> {
  const [r] = await sql<{ busy: boolean }[]>`
    select exists (
      select 1 from items i join runs r on r.id = i.run_id
      where i.status in (1, 2) and r.status in ('running', 'draining')
    ) or exists (select 1 from runs where status = 'running' and not source_done) as busy`;
  return r.busy;
}
