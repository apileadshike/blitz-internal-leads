import { defineConfig } from "@trigger.dev/sdk";

// Trigger.dev provides the compute for the queue workers. All work and state stay
// in Supabase Postgres; the tasks in src/trigger just run lib/engine/worker.ts.
export default defineConfig({
  project: "proj_tpogmljhdvfvvjqwsrjz",
  dirs: ["./src/trigger"],
  runtime: "node",
  // A drain task works for up to ~10 minutes, then hands over to a fresh one.
  maxDuration: 900,
  retries: {
    enabledInDev: true, // the Development environment is being used live (workers on this PC)
    default: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  },
});
