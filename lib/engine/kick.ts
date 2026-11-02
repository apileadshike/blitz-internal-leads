// Wakes the workers when new work lands in the queue.
//
//   EXECUTION=trigger → start the Trigger.dev "drain-queue" task (src/trigger/queue.ts)
//   otherwise         → nothing to do: the worker in the web server (or `npm run worker`) polls the queue
import { tasks } from "@trigger.dev/sdk";

export const usesTrigger = () => process.env.EXECUTION === "trigger";

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
