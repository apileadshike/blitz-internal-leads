// Server-wide objects: the Blitz client, the queue worker and the job scheduler.
// Kept on globalThis so each exists once per process (and survives hot reloads).
import "server-only";
import { BlitzAPI } from "blitz-api-js";
import { Scheduler } from "./jobs";
import { Worker } from "./engine/worker";

type Runtime = { client: BlitzAPI; worker: Worker; scheduler: Scheduler };
const g = globalThis as unknown as { __blitz?: Runtime };

export function blitzClient() {
  if (!process.env.BLITZ_API_KEY) throw new Error("Missing BLITZ_API_KEY. Put it in .env (see .env.example).");
  // Its rate limiter is per endpoint and per process. With several worker
  // processes, set BLITZ_RPS to your limit divided by the number of processes.
  return new BlitzAPI({
    api_key: process.env.BLITZ_API_KEY,
    rate_limit_rps: Number(process.env.BLITZ_RPS ?? 10),
    max_retries: 4,
  });
}

export function runtime(): Runtime {
  if (g.__blitz) return g.__blitz;
  const client = blitzClient();
  g.__blitz = { client, worker: new Worker(client), scheduler: new Scheduler() };
  return g.__blitz;
}
