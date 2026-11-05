// Worker: pulls work from Postgres and does it.
//
//   • Step work: claims a batch of ready items for one step with FOR UPDATE SKIP LOCKED
//     (so many workers never get the same row), calls the API for each, then commits
//     the whole batch in one transaction. A lease (renewed while working) means a
//     crashed worker's rows go back to the queue by themselves.
//   • Search paging: a search can be split into parts that don't overlap (e.g. one per
//     employee range). Each part has its own cursor and lease, so several parts are paged
//     at the same time. Each page is committed together with its cursor, so a crash
//     re-buys at most one page. Results being fetched are reserved on the run first, so
//     parallel parts never go past "Max results" or the record budget.
//   • Reaper: puts expired leases back, finishes runs, cleans up old queue rows.
//
// Where it runs:
//   • start(): forever, inside the web server or `npm run worker` (local / own server)
//   • drain(): until the queue is empty, inside a Trigger.dev task (src/trigger/queue.ts)
import { AuthenticationError, InsufficientRecordsError, APIStatusError, type BlitzAPI } from "blitz-api-js";
import type { ISql } from "postgres";
import { sql } from "../pg";
import { MAX_SPLITS, SEARCH_CAP, STEP_BY_ID, splitSearch, type Item, type Rec, type StepCtx } from "../steps";
import { describeError, hasInput, isTransient } from "./common";
import { cacheEnabled, cachedClient, pruneCache } from "./cache";
import { deleteFiles, type Store } from "../storage";
import {
  ITEM, add, addLogs, bump, drainRun, failRun, getRun, handOff, maybeFinish, stepDef, stepParams, stopRun,
  type Candidate, type Counters, type RunRow,
} from "./runs";

const LEASE_SECONDS = 120;
const BACKLOG_LIMIT = 1000; // stop fetching pages while this many rows wait (spend follows progress)
const PAGE_SIZE = 50;       // results per search page (Blitz maximum)
// Rows per batch: small, so one slow lookup holds up only a few rows. A step keeps several
// batches in flight (2 x "Workers per step" calls in total), so the pipeline never waits for a whole batch.
const BATCH_SIZE = Math.max(1, Number(process.env.BATCH_SIZE ?? 25));
const FLUSH_MS = 1000;      // run totals and step counters are written this often
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isFatal = (e: unknown) => e instanceof InsufficientRecordsError || e instanceof AuthenticationError;
const today = () => new Date().toISOString().slice(0, 10);

type Claimed = { id: string; data: Item; attempts: number };
type Pending = { stages: Map<number, Counters>; records: number; saved: number; usage: number; finish: boolean };
type Part = { run_id: string; shard: number; label: string; params: Rec | null; cursor: string | null; pages: number; count: number; exhausted: boolean };

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
  private sourceSlots = Number(process.env.SOURCE_CONCURRENCY ?? 8);
  private partsAt = 0;

  constructor(private client: BlitzAPI, private slots = Number(process.env.WORKER_SLOTS ?? 32)) {}

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
    this.flusher = setInterval(() => void this.flush(), FLUSH_MS);
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
    clearInterval(this.flusher);
    await this.flush();
  }

  // ── run totals, written once a second ─────────────────────────────────────
  // Every save used to add to the same few rows (the run's totals, the step counters), so saves
  // for a run had to wait for each other. Now a save only touches its own rows, and the totals
  // collect here and are written by one flush per second.
  private pending = new Map<string, Pending>();
  private writing = new Map<string, Pending>();
  private flushing?: Promise<void>;
  private flusher?: NodeJS.Timeout;

  /** Count a save's results toward the run's totals (written by the next flush). */
  private note(runId: string, counters: Map<number, Counters>, records: number, saved: number, isJob: boolean) {
    let p = this.pending.get(runId);
    if (!p) this.pending.set(runId, (p = { stages: new Map(), records: 0, saved: 0, usage: 0, finish: false }));
    for (const [stage, c] of counters) add(p.stages, stage, c);
    p.records += records;
    p.saved += saved;
    if (isJob) p.usage += records;
    p.finish = true; // check whether the run is finished once its totals are written
  }
  private finishSoon(runId: string) {
    this.note(runId, new Map(), 0, 0, false);
  }
  /** Records spent by a run that aren't in the database yet. */
  private unwritten(runId: string) {
    return (this.pending.get(runId)?.records ?? 0) + (this.writing.get(runId)?.records ?? 0);
  }

  /** Write the collected totals: one short transaction per run, step counters always in the same order. */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      const batch = this.pending;
      this.pending = new Map();
      this.writing = batch;
      for (const [runId, p] of batch) {
        try {
          await sql.begin(async (tx) => {
            await bump(tx, runId, p.stages);
            if (p.records || p.saved) await tx`update runs set records_used = records_used + ${p.records}, saved = saved + ${p.saved} where id = ${runId}`;
            if (p.usage) await tx`insert into usage (day, records) values (${today()}, ${p.usage}) on conflict (day) do update set records = usage.records + excluded.records`;
          });
        } catch (e) {
          console.error("[worker] saving run totals:", describeError(e));
          // Keep them for the next flush.
          const back = this.pending.get(runId);
          if (!back) this.pending.set(runId, p);
          else {
            for (const [stage, c] of p.stages) add(back.stages, stage, c);
            back.records += p.records; back.saved += p.saved; back.usage += p.usage; back.finish ||= p.finish;
          }
          continue;
        }
        if (p.finish) await maybeFinish(runId).catch(() => {});
      }
      this.writing = new Map();
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
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

  /** Split new searches into parts (once per run). A run that already paged keeps one part with its cursor. */
  private async ensureParts() {
    if (Date.now() - this.partsAt < 1000) return;
    this.partsAt = Date.now();
    const need = await sql<{ id: string; steps: RunRow["steps"]; source_cursor: string | null; source_pages: number; source_count: number }[]>`
      select id, steps, source_cursor, source_pages, source_count from runs r
      where status = 'running' and not source_done and not exists (select 1 from run_sources s where s.run_id = r.id)`;
    for (const r of need) {
      const def = STEP_BY_ID.get(r.steps[0].step)!;
      const fresh = !r.source_cursor && !r.source_pages;
      const parts = fresh ? splitSearch(def, r.steps[0].params ?? {}) : [{ label: "", params: null }];
      const made = await sql`
        insert into run_sources (run_id, shard, label, params, cursor, pages, count)
        select ${r.id}::text, (i - 1)::int, l, nullif(p, 'null')::jsonb, ${fresh ? null : r.source_cursor}::text,
               ${fresh ? 0 : r.source_pages}::int, ${fresh ? 0 : r.source_count}::int
        from unnest(${parts.map((x) => x.label)}::text[], ${parts.map((x) => JSON.stringify(x.params))}::text[]) with ordinality as t(l, p, i)
        on conflict do nothing`;
      if (made.count > 1) {
        await addLogs(sql, r.id, [{ stage: def.label, message: `Searching in ${parts.length} parts at the same time: ${parts.map((x) => x.label).join(" | ")}` }]);
      }
    }
  }

  /** Claim one part of a run's search (a lease, so only one worker pages it) and fetch its pages. */
  private async pageStep(): Promise<boolean> {
    await this.ensureParts();
    const [part] = await sql<{ run_id: string; shard: number }[]>`
      update run_sources s set lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
      from (
        select p.run_id, p.shard from run_sources p join runs r on r.id = p.run_id
        where r.status = 'running' and not r.source_done and not p.exhausted
          and (p.lease_until is null or p.lease_until < now())
          and (select count(*) from (select 1 from items where run_id = r.id and status = 1 limit ${BACKLOG_LIMIT}) b) < ${BACKLOG_LIMIT}
        -- fair share between jobs: the job with the fewest parts being fetched right now goes first,
        -- then the part with the fewest pages, so two jobs page their searches 50-50
        order by (select count(*) from run_sources q where q.run_id = p.run_id and q.lease_until > now()),
          p.pages, r.created_at, p.shard limit 1
        for update of p skip locked
      ) x
      where s.run_id = x.run_id and s.shard = x.shard
      returning s.run_id, s.shard`;
    if (!part) return false;
    let pauseSecs = 0;
    try {
      pauseSecs = await this.sourceJob(part.run_id, part.shard);
    } finally {
      // Release the part's lease (or keep it a while after a temporary error, as a back-off).
      await sql`update run_sources set lease_until = now() + make_interval(secs => ${pauseSecs}) where run_id = ${part.run_id} and shard = ${part.shard}`.catch(() => {});
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
      // Several small batches per step instead of two big ones: a slow lookup only holds up its own batch.
      const size = Math.max(1, Math.min(BATCH_SIZE, run.options.concurrency));
      const batches = def.maxConcurrency ? 1 : Math.ceil((2 * run.options.concurrency) / size);
      if ((this.busy.get(key) ?? 0) >= batches) continue;
      this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
      try {
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
    let saved = 0;
    // Only this batch's own rows are written here (queue rows, saved leads, logs): no shared row,
    // so batches never wait for each other. The run's totals go to note() and the next flush.
    await sql.begin(async (tx) => {
      saved = await handOff(tx, run, stage, pass, counters);
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
      await addLogs(tx, run.id, logs);
    });
    this.note(run.id, counters, c.records!, saved, !!run.job_id);
    if (fatal) await stopRun(run.id, fatal, "fatal");
    await this.checkBudgets(run.id, c.records!);
  }

  /** Over budget → stop fetching new pages (rows already bought still get finished). */
  private async checkBudgets(runId: string, records: number) {
    if (!records) return;
    const [r] = await sql<{ records_used: number; max_records: number; job_id: number | null }[]>`
      select records_used, max_records, job_id from runs where id = ${runId} and status in ('running', 'draining')`;
    if (!r) return;
    r.records_used += this.unwritten(runId); // spent but not written yet (next flush)
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
    // Plus job spending not written yet (next flush).
    let unwritten = 0;
    for (const m of [this.pending, this.writing]) for (const p of m.values()) unwritten += p.usage;
    return { ...this.dailyCache, spent: this.dailyCache.spent + unwritten };
  }

  // ── search paging (this worker holds the lease of one part of the run's search) ──
  private sourceErrors = new Map<string, number>();

  /**
   * Fetch pages of one part of a run's search until it's done, the queue is full enough, or we stop.
   * Returns a back-off in seconds (0 = none).
   */
  private async sourceJob(runId: string, shard: number): Promise<number> {
    const errKey = `${runId}:${shard}`;
    while (!this.stopping) {
      const run = await getRun(runId);
      if (!run || run.status !== "running" || run.source_done) return 0;
      const [part] = await sql<Part[]>`select * from run_sources where run_id = ${runId} and shard = ${shard}`;
      if (!part || part.exhausted) return 0;
      // Don't race ahead of the steps: spending should follow progress.
      const [{ backlog }] = await sql<{ backlog: number }[]>`
        select count(*)::int as backlog from (select 1 from items where run_id = ${runId} and status = 1 limit ${BACKLOG_LIMIT}) x`;
      if (backlog >= BACKLOG_LIMIT) return 0;
      await sql`update run_sources set lease_until = now() + make_interval(secs => ${LEASE_SECONDS}) where run_id = ${runId} and shard = ${shard}`;

      const def = stepDef(run, 0);
      const paged = !!def.split; // searches page with a cursor; pasted lists are read in one go
      const tag = part.label ? `[${part.label}] ` : "";
      // Budget-aware paging: each fetched result will still need its later steps (email, phone…).
      // Keep that money aside for the leads already queued and for the pages other parts are fetching.
      const later = laterCostPerResult(run);
      const firstCost = /^POST /.test(def.endpoint) ? 1 : 0;
      let want = 0;
      let ended = false;
      await sql.begin(async (tx) => {
        const [r] = await tx<{ status: string; source_done: boolean; max_items: number; max_records: number; records_used: number; source_count: number; source_reserved: number }[]>`
          select status, source_done, max_items, max_records, records_used, source_count, source_reserved from runs where id = ${runId} for update`;
        if (!r || r.status !== "running" || r.source_done) return;
        let room = r.max_items > 0 ? r.max_items - r.source_count - r.source_reserved : Infinity;
        let budgetMsg: string | null = null;
        if (later + firstCost > 0) {
          const [{ open }] = await tx<{ open: number }[]>`select count(*)::int as open from items where run_id = ${runId} and status in (1, 2)`;
          const left = r.max_records - (r.records_used + this.unwritten(runId)) - open * later - r.source_reserved * (later + firstCost);
          const affordable = Math.floor(left / (later + firstCost));
          if (affordable < room) {
            room = affordable;
            budgetMsg = `Fetching no more: the rest of the record budget (${Math.max(0, r.max_records - r.records_used).toLocaleString()}) is kept for the ${open.toLocaleString()} leads already found`;
          }
        }
        if (room <= 0) {
          // Nothing left to fetch. If other parts are still fetching a page, the last one ends the search.
          if (!r.source_reserved) {
            ended = true;
            await tx`update runs set source_done = true where id = ${runId}`;
            await addLogs(tx, runId, [{ stage: def.label, message: budgetMsg ?? `Reached the limit of ${r.source_count.toLocaleString()} results` }]);
          }
          return;
        }
        want = paged ? Math.min(PAGE_SIZE, room) : room;
        if (paged) await tx`update runs set source_reserved = source_reserved + ${want} where id = ${runId}`;
      });
      if (ended) this.finishSoon(runId);
      // Other parts hold the rest of the room for now: look again in a moment.
      if (want <= 0) return ended ? 0 : 2;

      let reserved = paged ? want : 0;
      const release = async () => {
        if (!reserved) return;
        const n = reserved;
        reserved = 0;
        await sql`update runs set source_reserved = greatest(source_reserved - ${n}, 0) where id = ${runId}`.catch(() => {});
      };
      try {
        const logs: { stage: string; message: string }[] = [];
        const items: Item[] = [];
        let records = 0, gotPage = false;
        let cursor: string | null = null;
        let total: number | null = null;
        const fromCache = { hits: 0 };
        const ctx: StepCtx = {
          client: this.lookupClient(run, def.noCache, fromCache),
          stopped: () => gotPage || this.stopping, // one page per pass
          charge: (resp) => { records += Number((resp as { fair_usage?: { records_used?: number } })?.fair_usage?.records_used ?? 0); },
          hit() {},
          log: (m) => logs.push({ stage: def.label, message: tag + m }),
          maxItems: want,
          concurrency: run.options.concurrency,
          startCursor: part.cursor ?? undefined,
          pagesDone: part.pages,
          saveCursor: (c) => { cursor = c; gotPage = true; },
          onTotal: (n) => { total = n; },
        };
        try {
          for await (const it of def.source!(part.params ?? stepParams(run, 0), ctx)) items.push(it);
        } catch (e) {
          await release();
          const msg = describeError(e);
          if (isFatal(e)) { await stopRun(runId, `Fatal API error: ${msg}`, "fatal"); return 0; }
          const tries = (this.sourceErrors.get(errKey) ?? 0) + 1;
          this.sourceErrors.set(errKey, tries);
          if (isTransient(e) && tries <= 5) {
            const wait = 15 * 2 ** (tries - 1); // 15s, 30s, 60s, 2m, 4m
            await addLogs(sql, runId, [{ stage: def.label, message: `${tag}Temporary error, retrying in ${wait}s: ${msg}` }]);
            return wait;
          }
          await addLogs(sql, runId, [{ stage: def.label, message: `${tag}Failed: ${msg}` }]);
          await failRun(runId, msg);
          return 0;
        }
        this.sourceErrors.delete(errKey);
        // This part has no more results (a pasted list is read in one go).
        let partDone = !gotPage || cursor === null || items.length === 0;
        // More matches than Blitz returns for one search (50,000): split this part again on another
        // filter (job level, job function, continent, industry…) so every piece fits under the cap.
        // Its first page is kept; the smaller parts find those people again and skip them as duplicates.
        let sub: { label: string; params: Rec | null }[] = [];
        const matches = total as number | null;
        if (paged && part.pages === 0 && !partDone && matches != null && matches > SEARCH_CAP) {
          // As many pieces as allowed (not just enough on paper): matches are rarely spread evenly.
          const split = splitSearch(def, part.params ?? stepParams(run, 0), Math.max(2, MAX_SPLITS), true);
          if (split.length > 1) {
            sub = split.map((x) => ({ label: part.label ? `${part.label} · ${x.label}` : x.label, params: x.params }));
            partDone = true;
            logs.push({ stage: def.label, message: `${tag}${matches.toLocaleString()} match, more than the ${SEARCH_CAP.toLocaleString()} Blitz returns per search: splitting it into ${sub.length} smaller parts` });
          } else {
            logs.push({ stage: def.label, message: `${tag}${matches.toLocaleString()} match, but Blitz returns at most ${SEARCH_CAP.toLocaleString()} per search and there is no filter left to split it by` });
          }
        }
        if (partDone && part.label && !sub.length) logs.push({ stage: def.label, message: `${tag}Finished: ${(part.count + items.length).toLocaleString()} results` });

        let kept = true;
        let limitHit = 0;
        let counters = new Map<number, Counters>();
        let saved = 0;
        const STOPPED = "run stopped while fetching";
        // Retried: a rare deadlock or timeout just rolls back, and the same page is saved again.
        for (let attempt = 1; ; attempt++) {
          try {
            await sql.begin(async (tx) => {
              // The page's own rows, then the run's paging columns last. Totals go to note() (next flush).
              const c = new Map<number, Counters>(); // fresh on every attempt, so a retry can't count twice
              add(c, 0, { received: items.length, done: items.length, records, cached: fromCache.hits });
              const n = await handOff(tx, run, 0, items.map((item) => ({ item })), c);
              const newCursor = gotPage ? cursor : part.cursor;
              await tx`
                update run_sources set cursor = ${newCursor}, pages = pages + ${gotPage ? 1 : 0},
                                       count = count + ${items.length}, exhausted = exhausted or ${partDone}
                where run_id = ${runId} and shard = ${shard}`;
              if (sub.length) {
                // New shard numbers after the highest one (one splitter per run at a time).
                await tx`select pg_advisory_xact_lock(hashtext(${"split:" + runId}))`;
                await tx`
                  insert into run_sources (run_id, shard, label, params, pages, count)
                  select ${runId}::text, (select coalesce(max(shard), -1) from run_sources where run_id = ${runId}) + i::int, l, p::jsonb, 0, 0
                  from unnest(${sub.map((x) => x.label)}::text[], ${sub.map((x) => JSON.stringify(x.params))}::text[]) with ordinality as t(l, p, i)`;
              }
              await addLogs(tx, runId, logs);
              const [u] = await tx<{ source_count: number; max_items: number }[]>`
                update runs set source_count = source_count + ${items.length}, source_pages = source_pages + ${gotPage ? 1 : 0},
                                source_cursor = case when ${shard}::int = 0 then ${newCursor}::text else source_cursor end,
                                source_reserved = greatest(source_reserved - ${reserved}, 0),
                                source_done = source_done or (max_items > 0 and source_count + ${items.length} >= max_items)
                where id = ${runId} and status in ('running', 'draining')
                returning source_count, max_items`;
              if (!u) throw new Error(STOPPED); // roll back: the page is not kept
              if (u.max_items > 0 && u.source_count >= u.max_items && u.source_count - items.length < u.max_items) limitHit = u.source_count;
              counters = c;
              saved = n;
            });
            reserved = 0; // released in the same transaction
            break;
          } catch (e) {
            if ((e as Error).message === STOPPED) { kept = false; break; }
            if (attempt >= 3) throw e;
            await sleep(500 * attempt);
          }
        }
        if (kept) this.note(runId, counters, records, saved, !!run.job_id);
        if (limitHit) await addLogs(sql, runId, [{ stage: def.label, message: `Reached the limit of ${limitHit.toLocaleString()} results` }]);
        // The last part to finish ends the search (after commit, so it sees every part's result).
        if (kept && partDone) {
          const [end] = await sql<{ source_count: number }[]>`
            update runs set source_exhausted = true, source_done = true
            where id = ${runId} and not source_exhausted
              and not exists (select 1 from run_sources where run_id = ${runId} and not exhausted)
            returning source_count`;
          if (end) await addLogs(sql, runId, [{ stage: def.label, message: `Search finished: ${end.source_count.toLocaleString()} results` }]);
        }
        this.lastWorkAt = Date.now();
        if (!kept) {
          // The run was stopped while this page was being fetched: those results were paid for but not kept.
          if (records) this.note(runId, new Map([[0, { records }]]), records, 0, !!run.job_id);
          return 0;
        }
        await this.checkBudgets(runId, records);
        if (partDone) return 0;
      } finally {
        await release();
      }
    }
    return 0;
  }

  // ── housekeeping ──────────────────────────────────────────────────────────
  /** Expired leases back to the queue, finish runs, clean up. Called on a timer and by the Trigger.dev cron. */
  async reap() {
    try {
      await this.flush(); // totals first, so a run isn't finished with counters still in memory
      // Rows held by a worker that died go back to the queue.
      const back = await sql`update items set status = 1, lease_until = null where status = 2 and lease_until < now()`;
      if (back.count) console.log(`[worker] ${back.count} rows from an expired lease went back to the queue`);
      // A worker that died mid-page leaves its reservation behind: drop it once no part is being fetched.
      await sql`update runs set source_reserved = 0 where source_reserved > 0
                and not exists (select 1 from run_sources where run_id = runs.id and lease_until > now())`;
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
      // A lead's queue row is dead weight once it is saved (done) or dropped: nothing reads it again
      // (failures are kept in item_failures). Clear them as we go, so a big run can't fill the disk.
      await sql`delete from items where id in (select id from items where status in (${ITEM.done}, ${ITEM.dropped}) limit 50000)`;
      // A finished run's own duplicate check is only needed while it runs.
      await sql`delete from run_seen where run_id in (select id from runs where status in ('done', 'error') and finished_at < now() - interval '10 minutes')`;
      // Finished runs don't need their queue rows any more (saved leads are in "rows").
      await sql`
        with old as (select id from runs where status = 'done' and finished_at < now() - interval '3 days')
        delete from items where run_id in (select id from old)`;
      await sql`delete from run_sources where run_id in (select id from runs where status not in ('running', 'draining') and finished_at < now() - interval '3 days')`;
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
