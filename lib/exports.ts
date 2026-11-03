// Background exports for big downloads: a worker writes the file to disk, uploads it
// to object storage (Cloudflare R2, or Supabase Storage), and the page gets a download link. No web request has to stay
// open for minutes (hosting time limits would cut it off).
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasks } from "@trigger.dev/sdk";
import { sql } from "./pg";
import { CONTENT_TYPES, writeExport, type LeadFilter } from "./leads";
import { currentStore, signedUrl, storageEnabled, uploadFile, type Store } from "./storage";
import { usesTrigger, workRunsElsewhere } from "./engine/kick";

export { storageEnabled };

export async function startExport(filter: LeadFilter, fmt: "csv" | "xlsx", name: string): Promise<string> {
  const id = `ex_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await sql`insert into exports (id, name, fmt, filter, status) values (${id}, ${name}, ${fmt}, ${JSON.stringify(filter)}::text::jsonb, 'queued')`;
  if (usesTrigger()) await tasks.trigger("export-leads", { id });
  else if (!workRunsElsewhere()) void runExport(id); // no separate worker: do it in this server process
  // EXECUTION=worker: the worker picks up queued exports within a few seconds.
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
    const store = currentStore();
    const base = `${id}/${ex.name.replace(/[^\w.-]+/g, "_")}.${ex.fmt}`;
    const path = store === "r2" ? `exports/${base}` : base;
    const bytes = await uploadFile(path, file, CONTENT_TYPES[ex.fmt], store);
    await sql`update exports set status = 'done', rows = ${rows}, bytes = ${bytes}, path = ${path}, store = ${store}, finished_at = now() where id = ${id}`;
  } catch (e) {
    await sql`update exports set status = 'failed', error = ${(e as Error).message}, finished_at = now() where id = ${id}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Status for the page; when done, a download link valid for an hour. */
export async function exportStatus(id: string) {
  const [ex] = await sql<{ name: string; fmt: string; status: string; rows: number | null; bytes: number | null; path: string | null; store: Store | null; error: string | null }[]>`
    select name, fmt, status, rows, bytes::float8 as bytes, path, store, error from exports where id = ${id}`;
  if (!ex) return null;
  const url = ex.status === "done" && ex.path ? await signedUrl(ex.path, 3600, `${ex.name}.${ex.fmt}`, ex.store ?? "supabase") : null;
  return { status: ex.status, rows: ex.rows, bytes: ex.bytes, error: ex.error, url };
}
