// Shared pieces of the pipeline engine: types, step validation, error text.
import { APIStatusError } from "blitz-api-js";
import { normUrl } from "../db";
import { STEP_BY_ID, type Entity, type Item, type Rec } from "../steps";

export type StepConfig = { step: string; params?: Rec };

/** Settings for one run (a builder run, or one cycle of a job). */
export type RunOptions = {
  steps: StepConfig[];
  maxItems: number; // max results pulled by the source (0 = all)
  concurrency: number; // lookups in flight per step
  maxRecords: number; // budget: stop fetching when this many records are spent
  skipSeenPeople: boolean; // skip people saved by earlier runs
  skipSeenCompanies: boolean; // skip companies saved by earlier runs
  useCache?: boolean; // reuse recent lookup answers instead of paying again (default on)
};

export type RunStatus = "running" | "draining" | "stopped" | "done" | "error";
/** Why a run ended early. */
export type StopKind = "user" | "budget" | "daily" | "fatal" | "shutdown";

export type StageStats = {
  id: string; label: string; group: string; dedupe_on: Entity | null; status: string;
  received: number; waiting: number; in_flight: number; done: number;
  out: number; duplicates: number; hits: number; errors: number; records: number;
  skipped: number; // rows passed through because they lacked this step's input
  filtered: number; // rows this step removed on purpose (e.g. ICP misfit, not new)
  cached: number; // lookups answered from the cache (free)
};
export type RunStats = {
  stages: StageStats[]; saved: number; records_used: number; max_records: number; failed?: number;
  /** For speed, ETA and the finished summary in the live view. */
  status?: string; elapsed?: number; max_items?: number; source_count?: number; source_done?: boolean;
};

/** Events the live view understands (same shape as before the queue rewrite). */
export type RunEvent =
  | { type: "stats"; stats: RunStats }
  | { type: "row"; row: Rec }
  | { type: "log"; at: number; stage: string; message: string }
  | { type: "finished"; status: string; error?: string };

/** Check a step list is valid: source first, and each step's input exists by then. */
export function validateSteps(steps: StepConfig[]): string | null {
  if (!steps.length) return "Add at least one step";
  const have = new Set<Entity>();
  for (const [i, s] of steps.entries()) {
    const def = STEP_BY_ID.get(s.step);
    if (!def) return `Unknown step "${s.step}"`;
    if (i === 0 && def.group !== "source") return "Step 1 must be a source";
    if (i > 0 && def.group === "source") return `"${def.label}" can only be step 1`;
    if (def.needs && !have.has(def.needs)) return `"${def.label}" needs ${def.needs} data, and no earlier step provides it`;
    def.gives.forEach((g) => have.add(g));
  }
  return null;
}

/** The key the duplicate check uses for an item. */
export const dedupeKey = (item: Item, on: Entity): string | undefined => {
  const v = on === "person" ? item.person?.person_linkedin_url : on === "company" ? item.company?.company_linkedin_url : item.job?.job_posting_url;
  return v ? (on === "job" ? String(v) : normUrl(String(v))) : undefined;
};

/** Does the item carry the record a step needs (with its LinkedIn URL)? */
export const hasInput = (item: Item, need: Entity) =>
  need === "person" ? !!item.person?.person_linkedin_url
  : need === "company" ? !!item.company?.company_linkedin_url
  : !!item.job;

export function describeError(e: unknown): string {
  if (e instanceof APIStatusError) {
    const body = e.body as { message?: string; errors?: { field: string; message: string }[] } | undefined;
    const details = body?.errors?.map((x) => `${x.field}: ${x.message}`).join("; ");
    return `HTTP ${e.status_code}${body?.message ? ": " + body.message : ""}${details ? " (" + details + ")" : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Network trouble, rate limits and server errors are worth retrying later. */
export function isTransient(e: unknown): boolean {
  if (e instanceof APIStatusError) return e.status_code === 429 || e.status_code >= 500;
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg);
}

export const newRunId = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(16).slice(2, 6);
