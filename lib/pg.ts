// Postgres connection (Supabase). Server-side only.
//
// The engine talks to the database directly over the Postgres protocol with
// DATABASE_URL (Supabase → Connect → "Session pooler"). That's much faster than
// the REST API for the batch writes a pipeline does, and it never exposes the
// tables to the browser: Row Level Security is switched on for every table with
// no policies, so the public (publishable) key can't read or write them.
import postgres from "postgres";
import { createHash } from "node:crypto";

type Sql = postgres.Sql<{}>;
const g = globalThis as unknown as { __sql?: Sql; __schema?: Promise<void> };

/**
 * Passwords with @ # / ? % etc. must be URL-encoded inside a connection string.
 * Accept them raw too: the password is everything between "user:" and the last "@".
 */
export function fixDatabaseUrl(url: string): string {
  const m = url.trim().match(/^(postgres(?:ql)?:\/\/)([^:/@]+):(.*)@([^@]+)$/);
  if (!m) return url.trim();
  const [, scheme, user, pass, rest] = m;
  let raw = pass;
  try { raw = decodeURIComponent(pass); } catch { /* not encoded */ }
  return `${scheme}${user}:${encodeURIComponent(raw)}@${rest}`;
}

/** Running as serverless functions (Vercel sets VERCEL=1). */
const serverless = !!process.env.VERCEL || process.env.SERVERLESS === "1";

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL. Add your Supabase connection string to .env (see .env.example).");
  return postgres(fixDatabaseUrl(url), {
    // Serverless (Vercel) starts many small instances: each keeps only a few connections and
    // lets them go quickly. Use Supabase's transaction pooler (port 6543) there.
    max: Number(process.env.DB_POOL_SIZE ?? (serverless ? 3 : 10)),
    idle_timeout: serverless ? 5 : 30,
    connect_timeout: 30,
    prepare: false, // works with Supabase's transaction pooler (port 6543) too
    onnotice: () => {},
  });
}

/** The shared pool, created on first use (so builds and imports don't need the env var). */
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply: (_t, _this, args) => (g.__sql ??= connect() as any)(...args),
  get: (_t, prop) => {
    const real = (g.__sql ??= connect()) as any;
    const v = real[prop];
    return typeof v === "function" ? v.bind(real) : v;
  },
});

const SCHEMA = `
  create table if not exists rows (
    id bigint generated always as identity primary key,
    run_id text not null,
    data jsonb not null,
    created_at timestamptz not null default now()
  );
  create index if not exists rows_run on rows (run_id, id);

  -- Cross-run duplicate memory: every person/company ever saved
  create table if not exists seen (
    kind text not null,
    key text not null,
    run_id text not null,
    primary key (kind, key)
  );

  -- "Only new since last run": seen keys per watch name
  create table if not exists watch (
    name text not null,
    key text not null,
    first_seen timestamptz not null default now(),
    primary key (name, key)
  );

  create table if not exists jobs (
    id integer generated always as identity primary key,
    key text unique not null,          -- file name, plus "#value" for split parts
    file text not null,
    name text not null,
    steps jsonb not null,
    settings jsonb not null,
    hash text not null,                -- of the steps: if they change, the job starts over
    status text not null,              -- waiting | running | paused | done | failed
    position integer not null,
    cursor text,                       -- where to continue; null = from the start
    pages integer not null default 0,
    rows integer not null default 0,
    records integer not null default 0,        -- this cycle (budget applies to this)
    records_total integer not null default 0,  -- all cycles
    batches integer not null default 0,
    cycles integer not null default 0,
    next_run_at text,
    note text,
    error text,
    run_id text,
    started_at text,
    finished_at text,
    created_at text not null
  );

  create table if not exists job_runs (
    run_id text primary key,
    job_id integer not null,
    started_at text not null,
    finished_at text,
    status text,
    rows integer not null default 0,
    records integer not null default 0
  );
  create index if not exists job_runs_job on job_runs (job_id, started_at);

  create table if not exists usage (day text primary key, records integer not null);
  create table if not exists settings (key text primary key, value text not null);

  -- ── Work queue ──────────────────────────────────────────────────────────
  -- A run is one execution of a pipeline (builder run, or one cycle of a job).
  create table if not exists runs (
    id text primary key,
    job_id integer,
    steps jsonb not null,
    options jsonb not null,             -- concurrency, skip-seen settings
    status text not null,               -- running | draining | stopped | done | error
    stop_kind text,                     -- why it stopped early: user | budget | daily | fatal | shutdown
    stop_reason text,
    error text,
    max_items integer not null default 0,     -- results from step 1 (0 = all)
    max_records integer not null,
    records_used integer not null default 0,
    saved integer not null default 0,
    source_count integer not null default 0,
    source_pages integer not null default 0,
    source_cursor text,                 -- where the search continues
    source_done boolean not null default false,        -- no more pages will be fetched (finished or winding down)
    source_exhausted boolean not null default false,   -- the search itself has no more results
    created_at timestamptz not null default now(),
    finished_at timestamptz
  );
  -- Search paging is claimed like items: one worker at a time per run, with a lease.
  alter table runs add column if not exists source_lease_until timestamptz;
  create index if not exists runs_active on runs (status) where status in ('running', 'draining');
  create index if not exists runs_job on runs (job_id, created_at);

  -- Per-step counters shown in the live view.
  create table if not exists run_stages (
    run_id text not null,
    stage integer not null,
    received integer not null default 0,
    done integer not null default 0,
    out integer not null default 0,
    duplicates integer not null default 0,
    hits integer not null default 0,
    errors integer not null default 0,
    records integer not null default 0,
    skipped integer not null default 0,
    filtered integer not null default 0,
    primary key (run_id, stage)
  );

  -- One row per lead in progress. "stage" is the step it waits for.
  -- Workers claim ready items in batches with FOR UPDATE SKIP LOCKED; a lease
  -- that runs out (crashed worker) puts the item back in the queue.
  create table if not exists items (
    id bigint generated always as identity primary key,
    run_id text not null,
    stage integer not null,
    status smallint not null,           -- 1 ready, 2 running, 3 done, 4 dropped
    data jsonb not null,                -- { company, person, job, extra }
    attempts smallint not null default 0,
    lease_until timestamptz,
    error text,
    updated_at timestamptz not null default now()
  );
  create index if not exists items_ready on items (run_id, stage, id) where status = 1;
  create index if not exists items_leased on items (lease_until) where status = 2;
  create index if not exists items_run_status on items (run_id, status, stage);

  -- In-run duplicate check (safe across many workers).
  create table if not exists run_seen (
    run_id text not null,
    kind text not null,
    key text not null,
    primary key (run_id, kind, key)
  );

  create table if not exists run_logs (
    id bigint generated always as identity primary key,
    run_id text not null,
    at timestamptz not null default now(),
    stage text not null,
    message text not null
  );
  create index if not exists run_logs_run on run_logs (run_id, id);

  -- Each lead in progress has a key, so a saved row can be replaced when its failed step is re-run.
  alter table rows add column if not exists item_key text;
  -- Job auto-retry: how many automatic retries have happened since the last success.
  alter table jobs add column if not exists retries integer not null default 0;

  -- A step that failed for a lead (after its retries): what it was given, and why it failed.
  -- "Re-run failed" puts these back into the queue at that step.
  create table if not exists item_failures (
    id bigint generated always as identity primary key,
    run_id text not null,
    stage integer not null,
    item_key text,
    data jsonb not null,
    error text not null,
    retried boolean not null default false,
    created_at timestamptz not null default now()
  );
  create index if not exists item_failures_run on item_failures (run_id) where not retried;
  alter table item_failures enable row level security;

  -- ── Fast search on the Leads page, even with millions of rows ──
  -- One lower-case text per row (name, company, email, domain, title), indexed with
  -- trigrams so "contains" searches use the index instead of reading every row.
  create extension if not exists pg_trgm with schema extensions;
  alter table rows add column if not exists search_text text generated always as (lower(
    coalesce(data->>'full_name', '') || ' ' || coalesce(data->>'company_name', '') || ' ' ||
    coalesce(data->>'email', '') || ' ' || coalesce(data->>'company_domain', '') || ' ' || coalesce(data->>'job_title', '')
  )) stored;
  create index if not exists rows_search on rows using gin (search_text extensions.gin_trgm_ops);
  -- Filters on the Leads page.
  create index if not exists rows_has_email on rows (id) where coalesce(data->>'email', '') <> '';
  create index if not exists rows_has_phone on rows (id) where coalesce(data->>'phone', '') <> '';
  create index if not exists rows_country on rows (upper(data->>'country'));
  create index if not exists rows_hq_country on rows (upper(data->>'company_hq_country'));

  -- Imported lists: the browser sends the rows in chunks, a job's list step reads them from here.
  create table if not exists uploads (
    id text primary key,
    name text not null,
    rows integer not null default 0,
    created_at timestamptz not null default now()
  );
  create table if not exists upload_rows (
    upload_id text not null,
    idx integer not null,
    value text not null,
    extra jsonb,                         -- the file's other columns for this row
    primary key (upload_id, idx)
  );
  alter table uploads enable row level security;
  alter table upload_rows enable row level security;

  -- Background exports: the file is written by a worker and kept in Supabase Storage.
  create table if not exists exports (
    id text primary key,
    name text not null,
    fmt text not null,
    filter jsonb not null,
    status text not null,                -- queued | running | done | failed
    rows integer,
    bytes bigint,
    path text,
    error text,
    created_at timestamptz not null default now(),
    finished_at timestamptz
  );
  alter table exports enable row level security;

  -- Alerts (job finished / failed / budget), shown on the Jobs page.
  create table if not exists alerts (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    level text not null,
    text text not null
  );
  alter table alerts enable row level security;

  -- Provider cache: answers to single-input lookups, so the same lookup isn't paid for twice.
  create table if not exists provider_cache (
    provider text not null,             -- e.g. "email", "domain_to_linkedin"
    key text not null,                  -- sha256 of the normalised input
    response jsonb not null,
    found boolean not null,
    fetched_at timestamptz not null default now(),
    expires_at timestamptz not null,
    primary key (provider, key)
  );
  create index if not exists provider_cache_expiry on provider_cache (expires_at);
  alter table provider_cache enable row level security;
  -- How many lookups per step were answered from the cache (free).
  alter table run_stages add column if not exists cached integer not null default 0;

  -- Light views: same rows without the step settings (an imported list can be megabytes).
  -- security_invoker keeps the tables' Row Level Security in force through the view.
  create or replace view runs_light with (security_invoker = true) as
    select id, job_id,
           (select coalesce(jsonb_agg(jsonb_build_object('step', s->'step')), '[]'::jsonb) from jsonb_array_elements(steps) s) as steps,
           options, status, stop_kind, stop_reason, error, max_items, max_records, records_used, saved,
           source_count, source_pages, source_cursor, source_done, source_exhausted, created_at, finished_at
    from runs;
  create or replace view jobs_light with (security_invoker = true) as
    select id, key, file, name,
           (select coalesce(jsonb_agg(jsonb_build_object('step', s->'step')), '[]'::jsonb) from jsonb_array_elements(steps) s) as steps,
           settings, hash, status, position, cursor, pages, rows, records, records_total, batches, cycles,
           next_run_at, note, error, run_id, started_at, finished_at, created_at, retries
    from jobs;

  alter table runs enable row level security;
  alter table run_stages enable row level security;
  alter table items enable row level security;
  alter table run_seen enable row level security;
  alter table run_logs enable row level security;

  -- Keep these tables private: no access through Supabase's public API keys.
  alter table rows enable row level security;
  alter table seen enable row level security;
  alter table watch enable row level security;
  alter table jobs enable row level security;
  alter table job_runs enable row level security;
  alter table usage enable row level security;
  alter table settings enable row level security;
`;

/** Create the tables if they don't exist yet (safe to run on every start). */
export function ensureSchema(): Promise<void> {
  return (g.__schema ??= applySchema().catch((e) => {
    g.__schema = undefined;
    throw e;
  }));
}

/**
 * Run the table setup only when it changed. ALTER TABLE / CREATE VIEW take strong
 * locks, so running them while workers write would block or deadlock them. A version
 * stamp (hash of SCHEMA) in `settings` makes repeat calls a single cheap read, and an
 * advisory lock makes sure only one process runs the setup at a time.
 */
async function applySchema() {
  const version = createHash("sha1").update(SCHEMA).digest("hex");
  const current = async () => {
    try {
      const [r] = await sql<{ value: string }[]>`select value from settings where key = 'schema_version'`;
      return r?.value;
    } catch { return undefined; } // first start: no settings table yet
  };
  if ((await current()) === version) return;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('blitz-lead-engine-schema'))`;
    const [r] = await tx<{ value: string }[]>`select value from settings where key = 'schema_version'`.catch(() => [] as { value: string }[]);
    if (r?.value === version) return; // another process just did it
    await tx.unsafe(SCHEMA);
    await tx`insert into settings (key, value) values ('schema_version', ${version}) on conflict (key) do update set value = excluded.value`;
  });
}
