// Job queue: one JSON file per pipeline in jobs/, run one after another.
// Job state lives in Supabase Postgres, and each job cycle is one run on the
// Postgres work queue (see engine/), so it survives restarts by design.
//
//   jobs/01-saas-us.json ─┐
//   jobs/02-fintech.json ─┼─▶ jobs table (status, budget, order) ─▶ scheduler ─▶ run (items queue + workers)
//   jobs/03-hiring.json  ─┘
//
// A job keeps going until its search has no more results. Then it is done (or, if
// it repeats, scheduled again) and the next job in the queue starts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch } from "node:fs";
import { join } from "node:path";
import { sql } from "./pg";
import { validateSteps, type StepConfig } from "./engine/common";
import { createRun, getRunLight, resumeRun, stopRun, type RunRow } from "./engine/runs";
import type { Rec } from "./steps";

export const JOBS_DIR = process.env.JOBS_DIR ?? "jobs";
/** Automatic retries after a job fails: wait 5 min, then 30 min, then 2 h, then give up and alert. */
const RETRY_MINUTES = [5, 30, 120];

// ── types ───────────────────────────────────────────────────────────────────
export type JobSettings = {
  batch_size: number;          // search results per batch
  record_budget: number;       // max records per cycle for this job
  workers: number;
  skip_seen_people: boolean;
  skip_seen_companies: boolean;
  repeat_every_hours: number | null;
  use_cache: boolean;           // reuse recent lookup answers (default on)
};
export type JobRow = {
  id: number; key: string; file: string; name: string; steps: StepConfig[]; settings: JobSettings | Record<string, never>; hash: string;
  status: "waiting" | "running" | "paused" | "done" | "failed"; position: number; cursor: string | null;
  pages: number; rows: number; records: number; records_total: number; batches: number; cycles: number;
  next_run_at: string | null; note: string | null; error: string | null; run_id: string | null;
  started_at: string | null; finished_at: string | null; created_at: string; retries: number;
};
type JobFile = Partial<JobSettings> & {
  name?: string;
  steps: StepConfig[];
  split?: { field: string; values: unknown[] };
};
type Parsed = { key: string; file: string; name: string; steps: StepConfig[]; settings: JobSettings; hash: string };

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10); // UTC day
const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.floor(n)) : d;
};
const settingsOf = (j: JobRow) => j.settings as JobSettings;

// ── settings (editable on the Jobs page) ────────────────────────────────────
async function getSettingsMap(): Promise<Record<string, string>> {
  const rows = await sql<{ key: string; value: string }[]>`select key, value from settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export async function schedulerSettings() {
  const s = await getSettingsMap();
  return {
    enabled: (s.enabled ?? "1") === "1",
    max_parallel: Number(s.max_parallel ?? process.env.MAX_PARALLEL_JOBS ?? 2),
    daily_budget: Number(s.daily_budget ?? process.env.DAILY_RECORD_BUDGET ?? 20000),
  };
}
export async function updateSchedulerSettings(b: Rec) {
  const set = (k: string, v: string) => sql`insert into settings (key, value) values (${k}, ${v}) on conflict (key) do update set value = excluded.value`;
  if (b.enabled !== undefined) await set("enabled", b.enabled ? "1" : "0");
  if (b.max_parallel !== undefined) await set("max_parallel", String(num(b.max_parallel, 2, 1, 10)));
  if (b.daily_budget !== undefined) await set("daily_budget", String(num(b.daily_budget, 20000, 1, 100_000_000)));
}

export async function spentToday(): Promise<number> {
  const [r] = await sql<{ records: number }[]>`select records from usage where day = ${today()}`;
  return r?.records ?? 0;
}

// ── job definitions ─────────────────────────────────────────────────────────
// Jobs saved from the builder live in the database (key "db:…"), which works on any
// host, Trigger.dev included. JSON files in jobs/ are an optional extra for a server
// with a disk: they are only read when JOB_FILES isn't "off" and the folder exists.
const DB_PREFIX = "db:";
export const jobFilesEnabled = () => process.env.JOB_FILES !== "off" && existsSync(JOBS_DIR);

/** Put `value` at a dotted path inside step 1's params. Single values become a one-item list. */
function setPath(obj: Rec, path: string, value: unknown) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {})) as Rec;
  o[keys.at(-1)!] = Array.isArray(value) ? value : [value];
}

function parseFile(file: string): Parsed[] | { error: string } {
  let j: JobFile;
  try { j = JSON.parse(readFileSync(join(JOBS_DIR, file), "utf8")); } catch (e) { return { error: `Can't read ${file}: ${(e as Error).message}` }; }
  return parseJob(file, j);
}

/** A job definition (file contents, or the "Save as job" body) → one job, or one per split value. */
function parseJob(file: string, j: JobFile): Parsed[] | { error: string } {
  if (!Array.isArray(j.steps)) return { error: `${file}: "steps" must be a list` };
  const base = file.replace(/^db:/, "").replace(/\.json$/i, "");
  const settings: JobSettings = {
    batch_size: num(j.batch_size, 1000, 1, 50_000),
    record_budget: num(j.record_budget, 5000, 1, 100_000_000),
    workers: num(j.workers, 20, 1, 50),
    skip_seen_people: j.skip_seen_people !== false,
    skip_seen_companies: j.skip_seen_companies === true,
    repeat_every_hours: j.repeat_every_hours ? Math.max(0.1, Number(j.repeat_every_hours)) : null,
    use_cache: j.use_cache !== false,
  };
  const make = (steps: StepConfig[], suffix?: string): Parsed => ({
    key: suffix ? `${file}#${suffix}` : file,
    file,
    name: (j.name ?? base) + (suffix ? ` [${suffix}]` : ""),
    steps,
    settings,
    hash: createHash("sha1").update(JSON.stringify(steps)).digest("hex"),
  });
  // Big filters: one job per value, e.g. one per country, run one after another.
  if (j.split?.field && Array.isArray(j.split.values) && j.split.values.length) {
    return j.split.values.map((v) => {
      const steps = structuredClone(j.steps);
      steps[0].params ??= {};
      setPath(steps[0].params, j.split!.field, v);
      return make(steps, Array.isArray(v) ? v.join("+") : String(v));
    });
  }
  return [make(j.steps)];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";

/** "Save as job" in the builder: stores the job in the database and queues it. */
export async function createJob(name: string, body: Omit<JobFile, "name">): Promise<{ key: string } | { error: string }> {
  const key = `${DB_PREFIX}${slug(name)}-${Date.now().toString(36)}`;
  const parsed = parseJob(key, { name, ...body });
  if ("error" in parsed) return parsed;
  for (const j of parsed) {
    const invalid = validateSteps(j.steps);
    if (invalid) return { error: invalid };
  }
  const [{ p }] = await sql<{ p: number }[]>`select coalesce(max(position), 0)::int as p from jobs`;
  let pos = p;
  for (const j of parsed) {
    await sql`insert into jobs (key, file, name, steps, settings, hash, status, position, created_at)
              values (${j.key}, ${j.file}, ${j.name}, ${JSON.stringify(j.steps)}::text::jsonb, ${JSON.stringify(j.settings)}::text::jsonb,
                      ${j.hash}, 'waiting', ${++pos}, ${now()})`;
  }
  alert("info", `New job queued: ${name}`);
  return { key };
}

// ── alerts ──────────────────────────────────────────────────────────────────
// Stored in Postgres, so alerts raised on a Trigger.dev worker show up on the Jobs page (Vercel).
export function alert(level: "info" | "error", text: string) {
  console.log(`[jobs] ${text}`);
  void sql`insert into alerts (level, text) values (${level}, ${text})`.catch((e) => console.error("Alert save failed:", e.message));
  const url = process.env.ALERT_WEBHOOK_URL; // Slack, Discord or any webhook
  if (url) {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) })
      .catch((e) => console.error("Alert webhook failed:", e.message));
  }
}
export async function recentAlerts(limit = 20) {
  return sql<{ at: Date; level: "info" | "error"; text: string }[]>`select at, level, text from alerts order by id desc limit ${limit}`;
}

// ── DB helpers ──────────────────────────────────────────────────────────────
export async function getJob(id: number): Promise<JobRow | undefined> {
  const [j] = await sql<JobRow[]>`select * from jobs where id = ${id}`;
  return j;
}
/** Jobs without step settings (steps = [{ step }] only): for lists and polling. */
export const listJobs = () => sql<JobRow[]>`select * from jobs_light order by position, id`;

type Patch = Partial<Omit<JobRow, "steps" | "settings">> & { steps?: StepConfig[]; settings?: JobSettings };
async function patch(id: number, fields: Patch) {
  const { steps, settings, ...rest } = fields;
  const f: Record<string, any> = { ...rest };
  for (const k of Object.keys(f)) if (f[k] === undefined) f[k] = null;
  const keys = Object.keys(f);
  if (keys.length) await sql`update jobs set ${sql(f, keys)} where id = ${id}`;
  // jsonb columns: send JSON text and let Postgres parse it (stored as real JSON, not a string)
  if (steps) await sql`update jobs set steps = ${JSON.stringify(steps)}::text::jsonb where id = ${id}`;
  if (settings) await sql`update jobs set settings = ${JSON.stringify(settings)}::text::jsonb where id = ${id}`;
}
/** Every run a job has made (for downloads). */
export async function jobRunIds(id: number): Promise<string[]> {
  return (await sql<{ id: string }[]>`select id from runs where job_id = ${id} order by created_at`).map((r) => r.id);
}

// ── scheduler ───────────────────────────────────────────────────────────────
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private shuttingDown = false;
  private budgetAlertDay = "";
  private ticking = false;
  private tickAgain = false;
  private filesAt = 0;
  private filesChanged = true;

  async start() {
    try {
      let t: NodeJS.Timeout | undefined;
      watch(JOBS_DIR, () => { clearTimeout(t); t = setTimeout(() => { this.filesChanged = true; void this.tick(); }, 1500); });
    } catch { /* fall back to the 60s scan */ }
    this.timer = setInterval(() => void this.tick(), 5_000);
    setTimeout(() => void this.tick(), 500);
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.timer);
  }

  /** Read the jobs/ folder: add new files, update changed ones, remove deleted ones. */
  async syncFiles() {
    if (!jobFilesEnabled()) return;
    const files = readdirSync(JOBS_DIR).filter((f) => f.toLowerCase().endsWith(".json") && !f.startsWith("_")).sort();
    const seen = new Set<string>();
    const [{ p }] = await sql<{ p: number }[]>`select coalesce(max(position), 0)::int as p from jobs`;
    let pos = p;
    const insert = (p: { key: string; file: string; name: string; steps: StepConfig[]; settings: JobSettings | {}; hash: string; status: string; error: string | null }) =>
      sql`insert into jobs (key, file, name, steps, settings, hash, status, position, error, created_at)
          values (${p.key}, ${p.file}, ${p.name}, ${JSON.stringify(p.steps)}::text::jsonb, ${JSON.stringify(p.settings)}::text::jsonb,
                  ${p.hash}, ${p.status}, ${++pos}, ${p.error}, ${now()})`;

    for (const file of files) {
      const parsed = parseFile(file);
      if ("error" in parsed) {
        const existing = await sql<JobRow[]>`select * from jobs where file = ${file}`;
        existing.forEach((j) => seen.add(j.key));
        if (!existing.length) {
          seen.add(file);
          await insert({ key: file, file, name: file.replace(/\.json$/i, ""), steps: [], settings: {}, hash: "", status: "failed", error: parsed.error });
          alert("error", parsed.error);
        } else for (const j of existing) if (j.error !== parsed.error && j.status !== "running") await patch(j.id, { status: "failed", error: parsed.error });
        continue;
      }
      for (const p of parsed) {
        seen.add(p.key);
        const invalid = validateSteps(p.steps);
        const [row] = await sql<JobRow[]>`select * from jobs where key = ${p.key}`;
        if (!row) {
          await insert({ ...p, status: invalid ? "failed" : "waiting", error: invalid });
          alert(invalid ? "error" : "info", invalid ? `${p.name}: ${invalid}` : `New job queued: ${p.name}`);
          continue;
        }
        if (row.status === "running") continue; // apply changes once it stops
        // Budget / workers / repeat changes apply without losing progress.
        const fields: Patch = {};
        if (row.name !== p.name) fields.name = p.name;
        if (JSON.stringify(row.settings) !== JSON.stringify(p.settings)) fields.settings = p.settings;
        if (row.hash !== p.hash) {
          // Different filters or steps: the saved progress no longer fits, start over.
          Object.assign(fields, {
            steps: p.steps, hash: p.hash, run_id: null, status: invalid ? "failed" : "waiting", error: invalid, next_run_at: null,
            note: "File changed: starting this job from the beginning",
          });
          if (invalid) alert("error", `${p.name}: ${invalid}`);
        } else if (row.status === "failed" && row.steps.length === 0 && !invalid) {
          Object.assign(fields, { steps: p.steps, status: "waiting", error: null }); // file was unreadable, now fixed
        }
        if (Object.keys(fields).length) await patch(row.id, fields);
      }
    }
    // Files deleted from the folder: forget the job (its saved rows stay in the database).
    for (const j of await listJobs()) {
      if (seen.has(j.key) || j.key.startsWith(DB_PREFIX)) continue; // builder jobs have no file
      if (j.run_id) await stopRun(j.run_id, "Job file was removed", "user");
      await sql`delete from jobs where id = ${j.id}`;
    }
  }

  /** Every few seconds: notice finished runs, then start the next jobs. Never runs twice at once. */
  async tick(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true;
    try {
      if (this.filesChanged || Date.now() - this.filesAt > 60_000) {
        this.filesChanged = false;
        this.filesAt = Date.now();
        try { await this.syncFiles(); } catch (e) { console.error("[jobs] scan failed:", (e as Error).message); }
      }
      // Jobs whose run has ended: decide what's next for each.
      for (const job of await sql<JobRow[]>`select * from jobs where status = 'running'`) {
        const run = job.run_id ? await getRunLight(job.run_id) : undefined;
        if (!run) await patch(job.id, { status: "waiting", run_id: null, note: "Run missing: starting again" });
        else if (run.status !== "running" && run.status !== "draining") await this.afterRun(job, run);
      }

      const s = await schedulerSettings();
      if (!s.enabled) return;
      if ((await spentToday()) >= s.daily_budget) {
        if (this.budgetAlertDay !== today()) {
          this.budgetAlertDay = today();
          alert("info", `Daily record budget of ${s.daily_budget.toLocaleString()} reached. The queue continues tomorrow (UTC).`);
        }
        return;
      }
      const [{ running }] = await sql<{ running: number }[]>`select count(*)::int as running from jobs where status = 'running'`;
      let free = s.max_parallel - running;
      if (free <= 0) return;
      const due = await sql<JobRow[]>`select * from jobs where status = 'waiting' and (next_run_at is null or next_run_at <= ${now()}) order by position, id`;
      for (const job of due) {
        if (free <= 0) break;
        const err = await this.startJob(job);
        if (!err) free--;
        else if (err === "Daily record budget reached") break;
      }
    } catch (e) {
      console.error("[jobs] tick failed:", (e as Error).message);
    } finally {
      this.ticking = false;
      if (this.tickAgain) { this.tickAgain = false; void this.tick(); }
    }
  }

  /** Start (or continue) a job's run. Returns an error message if it can't. */
  async startJob(job: JobRow, manual = false): Promise<string | void> {
    if (job.status === "running") return "Already running";
    const s = await schedulerSettings();
    if ((await spentToday()) >= s.daily_budget) return "Daily record budget reached";
    const invalid = validateSteps(job.steps);
    if (invalid) {
      await patch(job.id, { status: "failed", error: invalid });
      alert("error", `${job.name} failed: ${invalid}`);
      return invalid;
    }
    const st = settingsOf(job);
    const prev = job.run_id ? await getRunLight(job.run_id) : undefined;
    // A stopped run of this cycle continues where it left off; nothing is fetched twice.
    if (prev && prev.status !== "done") {
      if (prev.records_used >= st.record_budget) {
        await patch(job.id, { status: "paused", note: `Record budget of ${st.record_budget.toLocaleString()} used up. Raise "record_budget" in the file, then Resume.` });
        return "Job record budget used up";
      }
      if (prev.status === "running" || prev.status === "draining") await stopRun(prev.id, "Restarting", "user");
      await resumeRun(prev.id, st.record_budget);
      await patch(job.id, { status: "running", error: null, next_run_at: null, note: manual ? "Continued by hand" : "Continuing from the saved place" });
      return;
    }
    const runId = await createRun({
      steps: job.steps, maxItems: 0, concurrency: st.workers, maxRecords: st.record_budget,
      skipSeenPeople: st.skip_seen_people, skipSeenCompanies: st.skip_seen_companies, useCache: st.use_cache !== false,
    }, { jobId: job.id });
    await patch(job.id, {
      status: "running", run_id: runId, error: null, next_run_at: null, started_at: now(), finished_at: null,
      note: manual ? "Started by hand" : "Starting from the beginning",
    });
  }

  private async afterRun(job: JobRow, run: RunRow) {
    if (run.status === "error" || run.stop_kind === "fatal") {
      const err = run.error ?? run.stop_reason ?? "Unknown error";
      // Bad settings (HTTP 4xx other than 429) or a bad API key won't fix themselves; anything else gets retried.
      const permanent = /HTTP 4(?!29)dd/.test(err) || /authentic|api key|unauthori[sz]ed/i.test(err);
      const step = RETRY_MINUTES[job.retries];
      if (!permanent && step !== undefined) {
        const next = new Date(Date.now() + step * 60_000).toISOString();
        const wait = step < 60 ? `${step} min` : `${step / 60} h`;
        await patch(job.id, {
          status: "waiting", retries: job.retries + 1, next_run_at: next, error: null,
          note: `Error: ${err}. Retrying automatically in ${wait} (${job.retries + 1}/${RETRY_MINUTES.length})`,
        });
        alert("info", `${job.name} hit an error (${err}). It continues from where it stopped in ${wait}.`);
      } else {
        await patch(job.id, { status: "failed", error: err, note: permanent ? "Fix the job settings, then Retry" : `Gave up after ${job.retries} automatic retries`, finished_at: now() });
        alert("error", `${job.name} failed: ${err}. The queue moves on.`);
      }
    } else if (run.status === "done" || run.source_exhausted) {
      await this.complete(job, run);
    } else if (run.stop_kind === "daily") {
      await patch(job.id, { status: "waiting", note: "Daily record budget reached: continues tomorrow (UTC)" });
    } else if (run.stop_kind === "budget") {
      await patch(job.id, { status: "paused", note: `Record budget of ${settingsOf(job).record_budget.toLocaleString()} used up. Raise "record_budget" in the file, then Resume.` });
      alert("info", `${job.name} paused: its record budget is used up.`);
    } else if (run.stop_kind === "shutdown") {
      await patch(job.id, { status: "waiting", note: "Server restarted: continues from the saved place" });
    } else {
      await patch(job.id, { status: "paused", note: run.stop_reason ?? "Paused" });
    }
  }

  /** Search fully read: done, or rescheduled if the job repeats. */
  private async complete(job: JobRow, run: RunRow) {
    const st = settingsOf(job);
    const rows = job.rows + run.saved, total = job.records_total + run.records_used;
    const msg = `${job.name} finished: ${run.saved.toLocaleString()} rows, ${run.records_used.toLocaleString()} records`;
    if (st.repeat_every_hours) {
      const next = new Date(Date.now() + st.repeat_every_hours * 3600_000).toISOString();
      await patch(job.id, {
        status: "waiting", run_id: null, rows, records_total: total, cycles: job.cycles + 1, retries: 0,
        next_run_at: next, finished_at: now(), note: `Repeats every ${st.repeat_every_hours}h`,
      });
      alert("info", `${msg}. Runs again at ${next.slice(0, 16).replace("T", " ")} UTC.`);
    } else {
      await patch(job.id, { status: "done", rows, records_total: total, finished_at: now(), note: "Search fully read", cycles: job.cycles + 1, retries: 0 });
      alert("info", `${msg}. Next job starts.`);
    }
  }

  // ── buttons on the Jobs page ──
  async runNow(id: number): Promise<string | void> {
    const job = await getJob(id);
    if (!job) return "No such job";
    if (job.status === "done") await patch(id, { run_id: null }); // run a finished job again: new cycle
    const err = await this.startJob((await getJob(id))!, true);
    void this.tick();
    return err;
  }
  async pause(id: number) {
    const job = await getJob(id);
    if (!job) return;
    if (job.run_id) await stopRun(job.run_id, "Paused from the Jobs page", "user");
    await patch(id, { status: "paused", note: "Paused" });
  }
  async resume(id: number) {
    const job = await getJob(id);
    if (job && (job.status === "paused" || job.status === "failed")) await patch(id, { status: "waiting", error: null, note: "Resumed", retries: 0 });
    void this.tick();
  }
  async restart(id: number): Promise<string | void> {
    const job = await getJob(id);
    if (!job) return;
    if (job.status === "running") return "Pause it first";
    await patch(id, { status: "waiting", run_id: null, error: null, next_run_at: null, note: "Starting over from the beginning", retries: 0 });
    void this.tick();
  }
  /** Removes the job's file (moved to jobs/_deleted/) so it isn't re-added. Split files remove all parts. */
  async remove(id: number) {
    const job = await getJob(id);
    if (!job) return;
    for (const j of await sql<{ id: number; run_id: string | null }[]>`select id, run_id from jobs where file = ${job.file}`) {
      if (j.run_id) await stopRun(j.run_id, "Job deleted", "user");
      await sql`delete from jobs where id = ${j.id}`;
    }
    const src = join(JOBS_DIR, job.file);
    if (!job.file.startsWith(DB_PREFIX) && existsSync(src)) {
      mkdirSync(join(JOBS_DIR, "_deleted"), { recursive: true });
      renameSync(src, join(JOBS_DIR, "_deleted", `${Date.now()}-${job.file}`));
    }
  }
  async reorder(ids: number[]) {
    if (!ids.length) return;
    await sql`update jobs set position = o.pos from unnest(${ids}::int[]) with ordinality as o(id, pos) where jobs.id = o.id`;
  }

  /** Jobs page: each job with the live numbers of its current run. */
  async view() {
    const jobs = await listJobs();
    const ids = jobs.map((j) => j.run_id).filter((x): x is string => !!x);
    const runs = new Map((ids.length ? await sql<RunRow[]>`select * from runs_light where id = any(${ids}::text[])` : []).map((r) => [r.id, r]));
    const failed = new Map((ids.length ? await sql<{ run_id: string; n: number }[]>`
      select run_id, count(distinct coalesce(item_key, id::text))::int as n from item_failures
      where run_id = any(${ids}::text[]) and not retried group by run_id` : []).map((r) => [r.run_id, r.n]));
    return jobs.map((j) => {
      const run = j.run_id ? runs.get(j.run_id) : undefined;
      const st = "record_budget" in j.settings ? settingsOf(j) : null;
      const live = !!run && (run.status === "running" || run.status === "draining");
      return {
        id: j.id, name: j.name, file: j.file, status: j.status, position: j.position,
        pages: run?.source_pages ?? 0, rows: j.rows + (run && j.status !== "done" ? run.saved : 0),
        records: run && j.status !== "done" ? run.records_used : 0, records_total: j.records_total + (run && j.status !== "done" ? run.records_used : 0),
        record_budget: st?.record_budget ?? null, repeat_every_hours: st?.repeat_every_hours ?? null,
        batches: run?.source_count ?? 0, cycles: j.cycles,
        search_done: j.status === "done" || !!run?.source_exhausted, has_progress: !!run && !run.source_exhausted && run.source_pages > 0,
        steps: j.steps.map((s) => s.step),
        next_run_at: j.next_run_at, note: j.note, error: j.error,
        run_id: j.run_id, live, stopping: run?.status === "draining", failed: j.run_id ? failed.get(j.run_id) ?? 0 : 0, retries: j.retries,
        started_at: j.started_at, finished_at: j.finished_at,
      };
    });
  }
}
