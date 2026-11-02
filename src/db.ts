// SQLite database (built into Node 22+), stored in data/leads.db.
//   rows: every saved row, as JSON (columns depend on which steps ran)
//   seen: every person/company ever saved. This is the cross-run duplicate memory.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import type { Item, Rec } from "./steps.js";

// DATA_DIR lets a deployed server keep the database on a persistent disk.
export const DATA_DIR = process.env.DATA_DIR ?? "data";
mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(`${DATA_DIR}/leads.db`);

db.exec(`
  CREATE TABLE IF NOT EXISTS rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rows_run ON rows(run_id);
  CREATE TABLE IF NOT EXISTS seen (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  );
`);


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

const hasStmt = db.prepare("SELECT 1 FROM seen WHERE kind = ? AND key = ?");
const markStmt = db.prepare("INSERT OR IGNORE INTO seen (kind, key, run_id) VALUES (?, ?, ?)");
const rowStmt = db.prepare("INSERT INTO rows (run_id, data, created_at) VALUES (?, ?, ?)");

export const hasSeen = (kind: string, key: string) => hasStmt.get(kind, key) !== undefined;
export const markSeen = (kind: string, key: string, runId: string) => void markStmt.run(kind, key, runId);

export function saveRow(runId: string, row: Rec) {
  const now = new Date().toISOString();
  row.run_id = runId;
  row.saved_at = now;
  rowStmt.run(runId, JSON.stringify(row), now);
}

export function rowsFor(runId?: string): Rec[] {
  const q = runId
    ? db.prepare("SELECT data FROM rows WHERE run_id = ? ORDER BY id").all(runId)
    : db.prepare("SELECT data FROM rows ORDER BY id").all();
  return (q as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function counts() {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    rows: one("SELECT COUNT(*) AS n FROM rows"),
    people: one("SELECT COUNT(*) AS n FROM seen WHERE kind = 'person'"),
    companies: one("SELECT COUNT(*) AS n FROM seen WHERE kind = 'company'"),
  };
}

/** Move leads saved by the first version (fixed `leads` table) into the new tables, once. */
function migrateV1() {
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'").get();
  if (!old) return;
  const leads = db.prepare("SELECT * FROM leads").all() as Rec[];
  for (const l of leads) {
    const row: Rec = {
      ...l, person_linkedin_url: l.linkedin_url, country: l.country_code, saved_at: l.created_at,
      linkedin_url: undefined, country_code: undefined, created_at: undefined,
    };
    for (const k of Object.keys(row)) if (row[k] == null || row[k] === "") delete row[k];
    rowStmt.run(String(l.run_id), JSON.stringify(row), String(l.created_at));
    markStmt.run("person", normUrl(String(l.linkedin_url)), String(l.run_id));
    if (l.company_linkedin_url) markStmt.run("company", normUrl(String(l.company_linkedin_url)), String(l.run_id));
  }
  db.exec("DROP TABLE leads");
  if (leads.length) console.log(`Migrated ${leads.length} leads from v1 table`);
}

migrateV1();

// ── "Only new since last run" memory: one list of seen keys per watch name ──
db.exec(`
  CREATE TABLE IF NOT EXISTS watch (
    name TEXT NOT NULL,
    key TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    PRIMARY KEY (name, key)
  );
`);
const watchStmt = db.prepare("INSERT OR IGNORE INTO watch (name, key, first_seen) VALUES (?, ?, ?)");
/** Records the key under this watch name. Returns true if it had never been seen before. */
export function watchIsNew(name: string, key: string): boolean {
  return Number(watchStmt.run(name, key, new Date().toISOString()).changes) > 0;
}

// ── Saved people, latest row per person (for the job-change tracker) ──
export function savedPeople(limit: number, runId?: string): Rec[] {
  const out = new Map<string, Rec>();
  for (const r of rowsFor(runId)) {
    const url = r.person_linkedin_url as string | undefined;
    if (url) out.set(normUrl(url), r); // later rows overwrite earlier ones = latest data
  }
  return [...out.values()].slice(0, Number.isFinite(limit) ? limit : undefined);
}
