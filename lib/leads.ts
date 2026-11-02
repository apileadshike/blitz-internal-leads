// Saved leads: filtering, paging and streaming exports straight from Postgres.
// Exports read the rows in chunks of 2,000 and write them out as they go, so even
// millions of rows never sit in memory at once.
import { PassThrough, Readable } from "node:stream";
import ExcelJS from "exceljs";
import { sql } from "./pg";
import { orderColumns } from "./export";
import type { Rec } from "./steps";

export type LeadFilter = {
  q?: string; hasEmail?: boolean; hasPhone?: boolean; country?: string;
  jobId?: number; runIds?: string[];
};

export function filterFromQuery(p: URLSearchParams): LeadFilter {
  return {
    q: p.get("q")?.trim() || undefined,
    hasEmail: p.get("has_email") === "1" || undefined,
    hasPhone: p.get("has_phone") === "1" || undefined,
    country: p.get("country")?.trim().toUpperCase() || undefined,
    jobId: p.get("job") ? Number(p.get("job")) : undefined,
    runIds: p.get("run") ? [p.get("run")!] : undefined,
  };
}

/** The WHERE clause for a filter (always valid SQL; "true" when nothing is set). */
function where(f: LeadFilter) {
  const parts = [sql`true`];
  if (f.runIds) parts.push(sql`run_id = any(${f.runIds}::text[])`);
  if (f.jobId) parts.push(sql`run_id in (select id from runs where job_id = ${f.jobId})`);
  if (f.hasEmail) parts.push(sql`coalesce(data->>'email', '') <> ''`);
  if (f.hasPhone) parts.push(sql`coalesce(data->>'phone', '') <> ''`);
  if (f.country) parts.push(sql`(upper(data->>'country') = ${f.country} or upper(data->>'company_hq_country') = ${f.country})`);
  if (f.q) {
    // Every word must appear somewhere in name / company / email / domain / title.
    // search_text has a trigram index, so this stays fast with millions of rows.
    for (const word of f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
      parts.push(sql`search_text like ${`%${word.replace(/[%_\\]/g, (c) => "\\" + c)}%`}`);
    }
  }
  return parts.reduce((a, b) => sql`${a} and ${b}`);
}

const hasFilter = (f: LeadFilter) => !!(f.q || f.hasEmail || f.hasPhone || f.country || f.jobId || f.runIds);
/** Counting more than this exactly would read every match; above it we say "10,000+". */
export const COUNT_CAP = 10_000;

/**
 * How many leads match. Exact up to 10,000 matches; with no filter at all on a big
 * table, Postgres's own row estimate is used (instant instead of a full count).
 */
async function countMatches(f: LeadFilter): Promise<{ total: number; exact: boolean }> {
  if (!hasFilter(f)) {
    const [est] = await sql<{ n: number }[]>`select greatest(reltuples, 0)::float8 as n from pg_class where oid = 'public.rows'::regclass`;
    if (est && est.n > 100_000) return { total: Math.round(est.n), exact: false };
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from (select 1 from rows where ${where(f)} limit ${COUNT_CAP + 1}) x`;
  return n > COUNT_CAP ? { total: COUNT_CAP, exact: false } : { total: n, exact: true };
}

/** One page of leads, newest first, plus how many match. */
export async function leadsPage(f: LeadFilter, page: number, size: number) {
  const [rows, count] = await Promise.all([
    sql<{ data: Rec }[]>`select data from rows where ${where(f)} order by id desc limit ${size + 1} offset ${(page - 1) * size}`,
    countMatches(f),
  ]);
  return { rows: rows.slice(0, size).map((r) => r.data), ...count, hasMore: rows.length > size };
}

const CHUNK = 2000;

/** Every matching row, oldest first, a chunk at a time. */
async function* chunks(f: LeadFilter): AsyncGenerator<Rec[]> {
  const w = where(f);
  let last = 0;
  for (;;) {
    const batch = await sql<{ id: number; data: Rec }[]>`
      select id::float8 as id, data from rows where ${w} and id > ${last} order by id limit ${CHUNK}`;
    if (!batch.length) return;
    last = batch[batch.length - 1].id;
    yield batch.map((b) => b.data);
    if (batch.length < CHUNK) return;
  }
}

/** All column names that appear in the matching rows (one query, before streaming starts). */
async function columns(f: LeadFilter): Promise<string[]> {
  const keys = await sql<{ k: string }[]>`select distinct jsonb_object_keys(data) as k from rows where ${where(f)}`;
  return orderColumns(new Set(keys.map((k) => k.k)));
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Write every matching row as CSV or Excel into a Node stream (an HTTP response or a
 * file), a chunk of rows at a time. Resolves with the number of rows written.
 */
export async function writeExport(f: LeadFilter, fmt: "csv" | "xlsx", out: NodeJS.WritableStream): Promise<number> {
  const cols = await columns(f);
  let count = 0;
  if (fmt === "xlsx") {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out as any, useStyles: true, useSharedStrings: false });
    const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(12, c.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    for await (const batch of chunks(f)) {
      for (const r of batch) ws.addRow(cols.map((c) => (typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : r[c]))).commit();
      count += batch.length;
    }
    ws.commit();
    await wb.commit();
    return count;
  }
  const write = (text: string) => new Promise<void>((res, rej) => (out.write(text, (e) => (e ? rej(e) : res())) as unknown));
  const EOL = "\r\n";
  await write("﻿" + cols.join(",") + EOL);
  for await (const batch of chunks(f)) {
    await write(batch.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join(EOL) + EOL);
    count += batch.length;
  }
  await new Promise<void>((res) => out.end(res));
  return count;
}

/** Stream matching rows as a CSV or Excel download (fine for most sizes; huge ones use a background export). */
export async function exportResponse(f: LeadFilter, name: string, fmt: string | null): Promise<Response> {
  const kind = fmt === "xlsx" ? "xlsx" : "csv";
  const safe = name.replace(/[^\w.-]+/g, "_");
  const pass = new PassThrough();
  writeExport(f, kind, pass).catch((e) => pass.destroy(e as Error));
  return new Response(Readable.toWeb(pass) as ReadableStream, {
    headers: { "Content-Type": CONTENT_TYPES[kind], "Content-Disposition": `attachment; filename="${safe}.${kind}"` },
  });
}
