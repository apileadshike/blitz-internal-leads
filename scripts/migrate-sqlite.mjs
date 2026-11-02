// One-time copy of the old local database (data/leads.db, SQLite) into Supabase.
// Safe to run twice: rows already copied are skipped.
//
//   node scripts/migrate-sqlite.mjs            (reads .env for DATABASE_URL)
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { ensureSchema, sql } from "../lib/pg.ts";

try { process.loadEnvFile(".env"); } catch {}
try { process.loadEnvFile(".env.local"); } catch {}

const file = `${process.env.DATA_DIR ?? "data"}/leads.db`;
if (!existsSync(file)) { console.log(`No ${file}, nothing to migrate.`); process.exit(0); }
const lite = new DatabaseSync(file, { readOnly: true });
const has = (t) => !!lite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const chunks = (arr, n = 1000) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

await ensureSchema();

// rows (skip if this run_id was already copied)
if (has("rows")) {
  const done = new Set((await sql`select distinct run_id from rows`).map((r) => r.run_id));
  const rows = lite.prepare("SELECT run_id, data, created_at FROM rows ORDER BY id").all().filter((r) => !done.has(r.run_id));
  for (const c of chunks(rows)) {
    await sql`insert into rows (run_id, data, created_at)
      select r, d::jsonb, t from unnest(${c.map((r) => r.run_id)}::text[], ${c.map((r) => r.data)}::text[], ${c.map((r) => r.created_at)}::timestamptz[]) as x(r, d, t)`;
  }
  console.log(`rows: copied ${rows.length}`);
}

if (has("seen")) {
  const seen = lite.prepare("SELECT kind, key, run_id FROM seen").all();
  for (const c of chunks(seen)) {
    await sql`insert into seen (kind, key, run_id)
      select * from unnest(${c.map((r) => r.kind)}::text[], ${c.map((r) => r.key)}::text[], ${c.map((r) => r.run_id)}::text[])
      on conflict do nothing`;
  }
  console.log(`seen (duplicate memory): ${seen.length}`);
}

if (has("watch")) {
  const w = lite.prepare("SELECT name, key, first_seen FROM watch").all();
  for (const c of chunks(w)) {
    await sql`insert into watch (name, key, first_seen)
      select * from unnest(${c.map((r) => r.name)}::text[], ${c.map((r) => r.key)}::text[], ${c.map((r) => r.first_seen)}::timestamptz[])
      on conflict do nothing`;
  }
  console.log(`watch ("only new" memory): ${w.length}`);
}

if (has("usage")) {
  for (const u of lite.prepare("SELECT day, records FROM usage").all()) {
    await sql`insert into usage (day, records) values (${u.day}, ${u.records}) on conflict (day) do update set records = greatest(usage.records, excluded.records)`;
  }
}
if (has("settings")) {
  for (const s of lite.prepare("SELECT key, value FROM settings").all()) {
    await sql`insert into settings (key, value) values (${s.key}, ${s.value}) on conflict (key) do nothing`;
  }
}

// jobs keep their place (cursor) so they continue where they stopped
if (has("jobs")) {
  const jobs = lite.prepare("SELECT * FROM jobs ORDER BY position").all();
  const idMap = new Map();
  for (const j of jobs) {
    const [row] = await sql`
      insert into jobs (key, file, name, steps, settings, hash, status, position, cursor, pages, rows, records, records_total,
                        batches, cycles, next_run_at, note, error, run_id, started_at, finished_at, created_at)
      values (${j.key}, ${j.file}, ${j.name}, ${j.steps}::text::jsonb, ${j.settings}::text::jsonb, ${j.hash}, ${j.status === "running" ? "waiting" : j.status},
              ${j.position}, ${j.cursor}, ${j.pages}, ${j.rows}, ${j.records}, ${j.records_total}, ${j.batches}, ${j.cycles},
              ${j.next_run_at}, ${j.note}, ${j.error}, ${j.run_id}, ${j.started_at}, ${j.finished_at}, ${j.created_at})
      on conflict (key) do nothing
      returning id`;
    if (row) idMap.set(j.id, row.id);
  }
  if (has("job_runs")) {
    for (const r of lite.prepare("SELECT * FROM job_runs").all()) {
      if (!idMap.has(r.job_id)) continue;
      await sql`insert into job_runs (run_id, job_id, started_at, finished_at, status, rows, records)
        values (${r.run_id}, ${idMap.get(r.job_id)}, ${r.started_at}, ${r.finished_at}, ${r.status}, ${r.rows}, ${r.records})
        on conflict do nothing`;
    }
  }
  console.log(`jobs: ${idMap.size} copied`);
}

const [c] = await sql`select (select count(*)::int from rows) as rows, (select count(*)::int from seen) as seen`;
console.log(`Supabase now has ${c.rows} rows and ${c.seen} remembered people/companies.`);
await sql.end();
