// Standalone queue worker: `npm run worker`. Start as many as you like (on one
// machine or many). Each one claims batches from Postgres with SKIP LOCKED, so
// they never do the same row twice. The web app can then run with RUN_WORKER=false.
//
// Blitz rate limits are per API key: with N worker processes set BLITZ_RPS to
// about (your limit / N), e.g. 50 req/s and 2 workers → BLITZ_RPS=25.
import { Worker } from "../lib/engine/worker";
import { ensureSchema, sql } from "../lib/pg";
import { BlitzAPI } from "blitz-api-js";

try { process.loadEnvFile(".env"); } catch { /* env from the host */ }
if (!process.env.BLITZ_API_KEY) throw new Error("Missing BLITZ_API_KEY");

await ensureSchema();
const worker = new Worker(new BlitzAPI({
  api_key: process.env.BLITZ_API_KEY,
  rate_limit_rps: Number(process.env.BLITZ_RPS ?? 10),
  max_retries: 4,
}));
await worker.start();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log("[worker] stopping: finishing the batch in hand…");
    await worker.shutdown();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}
