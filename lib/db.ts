// Lead storage in Supabase Postgres (connection + tables: see pg.ts).
//   rows:  every saved row, as JSON (columns depend on which steps ran)
//   seen:  every person/company ever saved. This is the cross-run duplicate memory.
//   watch: "Only new since last run" memory
import type { Item, Rec } from "./steps";
import type { ISql } from "postgres";
import { sql } from "./pg";

/** Preferred column order in exports; anything else is appended after. */
export const COLUMN_ORDER = [
  "full_name", "first_name", "last_name", "job_title", "email", "phone",
  "company_name", "company_domain", "company_email_domain", "company_website",
  "person_linkedin_url", "company_linkedin_url", "headline", "city", "state", "country",
  "icp_tier", "company_industry", "company_size", "company_employees", "company_revenue_range",
  "company_founded_year", "company_type", "company_hq_city", "company_hq_state", "company_hq_country",
  "company_followers", "matched_jobs", "matched_people", "total_employees", "top_countries", "top_departments",
  "job_posting_title", "job_posting_url", "job_posted_at", "job_location", "job_summary",
  "connections", "email_status", "phone_status", "run_id", "saved_at",
];

/** Canonical LinkedIn URL so the same profile always gives the same key. */
export function normUrl(url: string): string {
  const path = url.trim().toLowerCase()
    .replace(/^https?:\/\/([a-z]{2,3}\.)?/, "") // drop scheme + www./uk. etc.
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  return "https://www." + path;
}

export function flatten(item: Item): Rec {
  const row: Rec = { ...item.company, ...item.person, ...item.job, ...item.extra };
  for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === null || row[k] === "") delete row[k];
  return row;
}

// ── saving rows ─────────────────────────────────────────────────────────────

/**
 * Save finished rows and remember their person/company, inside the caller's
 * transaction (a worker saves a batch together with the queue update).
 */
export async function insertRows(tx: ISql, runId: string, rows: Rec[], marks: { kind: string; key: string }[], keys: (string | null)[] = []) {
  if (!rows.length) return;
  const at = new Date().toISOString();
  for (const r of rows) { r.run_id = runId; r.saved_at = at; }
  await tx`
    insert into rows (run_id, data, created_at, item_key)
    select ${runId}::text, d::jsonb, ${at}::timestamptz, k
    from unnest(${rows.map((r) => JSON.stringify(r))}::text[], ${rows.map((_, i) => keys[i] ?? null)}::text[]) as t(d, k)`;
  if (marks.length) {
    await tx`
      insert into seen (kind, key, run_id)
      select k, v, ${runId}::text from unnest(${marks.map((m) => m.kind)}::text[], ${marks.map((m) => m.key)}::text[]) as t(k, v)
      on conflict do nothing`;
  }
}

// ── reading ─────────────────────────────────────────────────────────────────
/** Rows of one run, of several runs, or (no argument) all rows, oldest first. */
export async function rowsFor(runId?: string | string[]): Promise<Rec[]> {
  const q = runId === undefined
    ? sql<{ data: Rec }[]>`select data from rows order by id`
    : Array.isArray(runId)
      ? sql<{ data: Rec }[]>`select data from rows where run_id = any(${runId}::text[]) order by id`
      : sql<{ data: Rec }[]>`select data from rows where run_id = ${runId} order by id`;
  return (await q).map((r) => r.data);
}

/**
 * Approximate totals for the builder header. Instant: read from Postgres's table statistics
 * (kept up to date by autovacuum) instead of counting millions of rows one by one, which
 * took minutes and made the builder page time out.
 */
export async function counts(): Promise<{ rows: number | null; people: number | null; companies: number | null }> {
  try {
    const [c] = await sql<{ rows: string | null; people: string | null; companies: string | null }[]>`
      with t as (select relname, greatest(reltuples, 0)::float8 as n from pg_class
                 where oid in ('public.rows'::regclass, 'public.seen'::regclass)),
           f as (select u.v, u.f from pg_stats s, unnest(s.most_common_vals::text::text[], s.most_common_freqs) as u(v, f)
                 where s.schemaname = 'public' and s.tablename = 'seen' and s.attname = 'kind')
      select (select n from t where relname = 'rows')::bigint as rows,
             ((select n from t where relname = 'seen') * coalesce((select f from f where v = 'person'), 1))::bigint as people,
             ((select n from t where relname = 'seen') * coalesce((select f from f where v = 'company'), 0))::bigint as companies`;
    const num = (v: string | null) => (v == null ? null : Number(v));
    return { rows: num(c.rows), people: num(c.people), companies: num(c.companies) };
  } catch {
    return { rows: null, people: null, companies: null }; // the numbers are only informational
  }
}

// ── "Only new since last run" ───────────────────────────────────────────────
/** Records the key under this watch name. Returns true if it had never been seen before. */
export async function watchIsNew(name: string, key: string): Promise<boolean> {
  const r = await sql`insert into watch (name, key) values (${name}, ${key}) on conflict do nothing returning 1`;
  return r.length > 0;
}

// ── Saved people, latest row per person (for the job-change tracker) ────────
export async function savedPeople(limit: number, runId?: string): Promise<Rec[]> {
  const lim = Number.isFinite(limit) ? limit : null;
  const rows = await sql<{ data: Rec }[]>`
    select distinct on (lower(data->>'person_linkedin_url')) data
    from rows
    where data ? 'person_linkedin_url' ${runId ? sql`and run_id = ${runId}` : sql``}
    order by lower(data->>'person_linkedin_url'), id desc
    ${lim ? sql`limit ${lim}` : sql``}`;
  return rows.map((r) => r.data);
}

// ── imported lists ──────────────────────────────────────────────────────────
/** The rows of an uploaded list, in file order (at most `limit`). */
export async function uploadRows(uploadId: string, limit: number): Promise<{ value: string; extra: Rec | null }[]> {
  const lim = Number.isFinite(limit) ? limit : 10_000_000;
  // Lists put straight into R2 by the browser: one {"v","x"} JSON object per line.
  const [up] = await sql<{ object_key: string | null }[]>`select object_key from uploads where id = ${uploadId}`;
  if (up?.object_key) {
    const { r2Lines } = await import("./storage");
    const out: { value: string; extra: Rec | null }[] = [];
    for await (const line of r2Lines(up.object_key)) {
      const r = JSON.parse(line) as { v: string; x?: Rec };
      out.push({ value: String(r.v), extra: r.x ?? null });
      if (out.length >= lim) break;
    }
    return out;
  }
  return sql<{ value: string; extra: Rec | null }[]>`
    select value, extra from upload_rows where upload_id = ${uploadId} order by idx limit ${lim}`;
}
