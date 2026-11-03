// Node.js-only startup: creates the database tables (Supabase), starts a queue
// worker and the job scheduler, and handles shutdown so workers finish the batch
// in hand before the process exits. Loaded from instrumentation.ts.
//
// RUN_WORKER=false runs the web app only, if workers run as separate processes (`npm run worker`).
import { runtime } from "./lib/runtime";
import { JOBS_DIR } from "./lib/jobs";
import { ensureSchema, sql } from "./lib/pg";
import { usesTrigger, workRunsElsewhere } from "./lib/engine/kick";

const g = globalThis as unknown as { __started?: boolean };

if (!g.__started) {
  g.__started = true;
  try {
    await ensureSchema();
    console.log("Database ready (Supabase)");
    const rt = runtime();
    if (usesTrigger()) {
      // Trigger.dev runs the workers (drain-queue) and the scheduler (scheduler-tick cron).
      console.log("EXECUTION=trigger: queue work and scheduling run on Trigger.dev");
    } else if (workRunsElsewhere()) {
      // The always-on worker (`npm run worker`, e.g. on the VPS) runs the queue, scheduler and exports.
      console.log("EXECUTION=worker: queue work, scheduling and exports run in the separate worker process");
    } else {
      if (process.env.RUN_WORKER !== "false") await rt.worker.start();
      await rt.scheduler.start();
      console.log(`Job scheduler started (jobs folder: ${JOBS_DIR})`);
    }
    if (!process.env.APP_PASSWORD && process.env.NODE_ENV === "production") {
      console.warn("WARNING: APP_PASSWORD is not set. Anyone who finds this URL can run jobs and spend records.");
    }
    // Redeploys send SIGTERM. With NEXT_MANUAL_SIG_HANDLE=true (set in the Dockerfile)
    // Next.js leaves signals to us. Unfinished rows stay in the queue for the next start.
    let closing = false;
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, async () => {
        if (closing) process.exit(1);
        closing = true;
        await rt.scheduler.shutdown();
        await rt.worker.shutdown();
        await sql.end({ timeout: 5 }).catch(() => {});
        process.exit(0);
      });
    }
  } catch (e) {
    console.error(`Startup failed: ${(e as Error).message}`);
  }
}
