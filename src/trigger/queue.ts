// Trigger.dev tasks: compute for the Postgres work queue.
//
//   drain-queue     runs the queue worker until there's nothing left to do (max ~10 min),
//                   then hands over to a fresh copy of itself if work remains.
//                   Started by the web app when work appears (lib/engine/kick.ts).
//   scheduler-tick  every minute: return expired leases to the queue, start due jobs,
//                   and start drain-queue if anything is waiting.
//
// The work itself (leads, steps, cursors, leases) lives in Supabase, so a lost or
// failed task loses nothing: the next one picks up where it stopped.
import { queue, schedules, task, tasks } from "@trigger.dev/sdk";
import { BlitzAPI } from "blitz-api-js";
import { Worker, hasPendingWork } from "../../lib/engine/worker";
import { Scheduler } from "../../lib/jobs";
import { ensureSchema } from "../../lib/pg";

// At most this many drain tasks run at once. Blitz's rate limit is per API key,
// so each task gets an equal share of it (see blitz()).
const DRAIN_TASKS = 2;
export const drainQueue = queue({ name: "drain-queue", concurrencyLimit: DRAIN_TASKS });

function blitz() {
  if (!process.env.BLITZ_API_KEY) throw new Error("Missing BLITZ_API_KEY (add it to the Trigger.dev environment variables)");
  return new BlitzAPI({
    api_key: process.env.BLITZ_API_KEY,
    rate_limit_rps: Math.max(1, Math.floor(Number(process.env.BLITZ_RPS ?? 50) / DRAIN_TASKS)),
    max_retries: 4,
    timeout: Number(process.env.BLITZ_TIMEOUT ?? 120),
  });
}

export const drainQueueTask = task({
  id: "drain-queue",
  queue: drainQueue,
  maxDuration: 900,
  run: async (payload: { reason?: string }) => {
    await ensureSchema(); // tables/views exist even if the code changed since the web app last started
    const worker = new Worker(blitz());
    const started = Date.now();
    const more = await worker.drain({ idleMs: 10_000, maxMs: 10 * 60_000 });
    if (more) await tasks.trigger<typeof drainQueueTask>("drain-queue", { reason: "continue" });
    return { reason: payload?.reason ?? null, seconds: Math.round((Date.now() - started) / 1000), moreWork: more };
  },
});

export const schedulerTick = schedules.task({
  id: "scheduler-tick",
  cron: { pattern: "* * * * *", window: "5m" }, // a missed minute is skipped, not piled up
  maxDuration: 120,
  run: async () => {
    await ensureSchema();
    await new Worker(blitz()).reap();
    await new Scheduler().tick();
    const pending = await hasPendingWork();
    if (pending) {
      const minute = Math.floor(Date.now() / 60_000);
      await tasks.trigger<typeof drainQueueTask>("drain-queue", { reason: "tick" }, { idempotencyKey: `tick-${minute}`, idempotencyKeyTTL: "5m" });
    }
    return { pending };
  },
});

/** Big download: write the file, put it in Supabase Storage (lib/exports.ts). */
export const exportLeads = task({
  id: "export-leads",
  maxDuration: 3600,
  run: async (payload: { id: string }) => {
    await ensureSchema();
    const { runExport } = await import("../../lib/exports");
    await runExport(payload.id);
    return { id: payload.id };
  },
});
