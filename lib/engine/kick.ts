// Wakes the workers when new work lands in the queue.
//
//   EXECUTION=worker  → nothing to do: the always-on worker (`npm run worker`, on the VPS) polls the queue
//   EXECUTION=trigger → start the Trigger.dev "drain-queue" task (src/trigger/queue.ts)
//   not set           → nothing to do: the web server runs its own worker and scheduler
import { tasks } from "@trigger.dev/sdk";

export const usesTrigger = () => process.env.EXECUTION === "trigger";
/** Background work runs somewhere else (a separate worker process or Trigger.dev), not in this web server. */
export const workRunsElsewhere = () => process.env.EXECUTION === "worker" || usesTrigger();

/** Start a drain task. Calls in the same 10 seconds share one task (idempotency key). */
export async function kick(reason = "new work") {
  if (!usesTrigger()) return;
  const slot = Math.floor(Date.now() / 10_000);
  try {
    await tasks.trigger("drain-queue", { reason }, { idempotencyKey: `drain-${slot}`, idempotencyKeyTTL: "1m" });
  } catch (e) {
    // The scheduler-tick cron starts a drain within a minute anyway.
    console.error("[kick] could not start drain-queue:", (e as Error).message);
  }
}
