// Background exports for big downloads: a worker writes the file to disk, uploads it
// to Supabase Storage, and the page gets a download link. No web request has to stay
// open for minutes (hosting time limits would cut it off).
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasks } from "@trigger.dev/sdk";
import { sql } from "./pg";
import { CONTENT_TYPES, writeExport, type LeadFilter } from "./leads";
import { signedUrl, storageEnabled, uploadFile } from "./storage";
import { usesTrigger } from "./engine/kick";

export { storageEnabled };

export async function startExport(filter: LeadFilter, fmt: "csv" | "xlsx", name: string): Promise<string> {
  const id = `ex_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await sql`insert into exports (id, name, fmt, filter, status) values (${id}, ${name}, ${fmt}, ${JSON.stringify(filter)}::text::jsonb, 'queued')`;
  if (usesTrigger()) await tasks.trigger("export-leads", { id });
  else void runExport(id); // no Trigger.dev: do it in this server process
  return id;
}

/** Write the file and upload it. Runs in a Trigger.dev task (or the local server). */
export async function runExport(id: string) {
  const [ex] = await sql<{ name: string; fmt: "csv" | "xlsx"; filter: LeadFilter }[]>`
    update exports set status = 'running' where id = ${id} and status in ('queued', 'running') returning name, fmt, filter`;
  if (!ex) return;
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  const file = join(dir, `export.${ex.fmt}`);
  try {
    const rows = await writeExport(ex.filter, ex.fmt, createWriteStream(file));
    const path = `${id}/${ex.name.replace(/[^\w.-]+/g, "_")}.${ex.fmt}`;
    const bytes = await uploadFile(path, file, CONTENT_TYPES[ex.fmt]);
    await sql`update exports set status = 'done', rows = ${rows}, bytes = ${bytes}, path = ${path}, finished_at = now() where id = ${id}`;
  } catch (e) {
    await sql`update exports set status = 'failed', error = ${(e as Error).message}, finished_at = now() where id = ${id}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Status for the page; when done, a download link valid for an hour. */
export async function exportStatus(id: string) {
  const [ex] = await sql<{ name: string; fmt: string; status: string; rows: number | null; bytes: number | null; path: string | null; error: string | null }[]>`
    select name, fmt, status, rows, bytes::float8 as bytes, path, error from exports where id = ${id}`;
  if (!ex) return null;
  const url = ex.status === "done" && ex.path ? await signedUrl(ex.path, 3600, `${ex.name}.${ex.fmt}`) : null;
  return { status: ex.status, rows: ex.rows, bytes: ex.bytes, error: ex.error, url };
}
