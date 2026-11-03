// The worker: one always-on process that does all background work.
//
//   bun scripts/worker.ts        (npm run worker)       ← on the VPS
//   tsx scripts/worker.ts        (npm run worker:node)  ← same thing on plain Node
//
// It does what the Trigger.dev tasks did:
//   • queue      claims batches from Postgres (SKIP LOCKED), calls Blitz, saves results
//   • scheduler  starts due jobs, repeats, auto-retries (every 5 s)
//   • exports    builds big downloads and puts them in R2 / Supabase Storage
//   • reaper     expired leases back to the queue, cleanup (every 20 s)
//
// The website (Vercel, EXECUTION=worker) only writes jobs and runs into the database;
// this process picks them up. Everything lives in Supabase, so stopping or restarting
// it loses nothing: unfinished rows return to the queue when their lease runs out.
//
// More worker processes may run at once (SKIP LOCKED keeps them apart). Give each one
// BLITZ_RPS = your limit / number of processes, and set RUN_SCHEDULER=false on all but one.
import { hostname } from "node:os";
import { BlitzAPI } from "blitz-api-js";
import { Worker } from "../lib/engine/worker";
import { Scheduler } from "../lib/jobs";
import { ensureSchema, sql } from "../lib/pg";
import { runExport } from "../lib/exports";
import { describeError } from "../lib/engine/common";

try { process.loadEnvFile?.(".env"); } catch { /* Bun loads .env itself; on a host the env is set */ }
if (!process.env.BLITZ_API_KEY) throw new Error("Missing BLITZ_API_KEY");
if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "Bun" : "Node";
console.log(`[worker] ${runtime} on ${hostname()}, starting…`);

await ensureSchema();

const worker = new Worker(new BlitzAPI({
  api_key: process.env.BLITZ_API_KEY,
  rate_limit_rps: Number(process.env.BLITZ_RPS ?? 10),
  max_retries: 4,
}));
await worker.start();

const scheduler = process.env.RUN_SCHEDULER === "false" ? null : new Scheduler();
if (scheduler) {
  await scheduler.start();
  console.log("[worker] scheduler started");
}

// ── background exports ──────────────────────────────────────────────────────
let exporting = false;
let stopping = false;
async function exportsTick() {
  if (exporting || stopping) return;
  exporting = true;
  try {
    // A worker that died mid-export leaves it "running": give up on it after 2 hours.
    await sql`update exports set status = 'failed', error = 'The worker stopped while building this file. Start the export again.', finished_at = now()
              where status = 'running' and created_at < now() - interval '2 hours'`;
    for (;;) {
      const [ex] = await sql<{ id: string }[]>`
        update exports set status = 'running'
        where id = (select id from exports where status = 'queued' order by created_at limit 1 for update skip locked)
        returning id`;
      if (!ex || stopping) break;
      console.log(`[worker] export ${ex.id}…`);
      await runExport(ex.id);
    }
  } catch (e) {
    console.error("[worker] exports:", describeError(e));
  } finally {
    exporting = false;
  }
}
const exportTimer = setInterval(() => void exportsTick(), 3_000);

// Heartbeat: the Jobs page warns when no worker has checked in for a while.
const beat = () => sql`insert into settings (key, value) values ('worker_heartbeat', ${new Date().toISOString()})
                       on conflict (key) do update set value = excluded.value`.catch(() => {});
await beat();
const beatTimer = setInterval(() => void beat(), 15_000);
console.log("[worker] ready");

// ── stop cleanly (pm2 restart, systemd stop, Ctrl+C) ────────────────────────
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("[worker] stopping: finishing the batch in hand…");
    clearInterval(exportTimer);
    clearInterval(beatTimer);
    await scheduler?.shutdown();
    await worker.shutdown();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}
