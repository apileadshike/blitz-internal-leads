// Generic pipeline engine. You pick the steps; every step runs at the same time.
//
//   [source] ─items─▶ [step 2] ─items─▶ [step 3] ─▶ … ─▶ [save]
//
// Each step has its own queue and its own pool of workers. An item is handed to
// the next step the moment it's ready, so the source keeps fetching pages while
// later steps are already working on earlier items.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { BlitzAPI, InsufficientRecordsError, AuthenticationError, APIStatusError } from "blitz-api-js";
import { STEP_BY_ID, type Entity, type Item, type Rec, type StepCtx, type StepDef } from "./steps.js";
import { hasSeen, markSeen, normUrl, saveRow, flatten } from "./db.js";

export type StepConfig = { step: string; params?: Rec };
export type RunOptions = {
  steps: StepConfig[];
  maxItems: number; // max results pulled by the source (0 = all)
  concurrency: number; // workers per step
  maxRecords: number; // budget: stop when this many records are spent
  skipSeenPeople: boolean; // skip people saved by earlier runs
  skipSeenCompanies: boolean; // skip companies saved by earlier runs
  startCursor?: string; // resume point (scheduled jobs)
  onCursor?: (cursor: string | null) => void;
};

type Status = "running" | "done" | "stopped" | "error";
export type StageStats = {
  id: string; label: string; group: string; dedupe_on: Entity | null; status: Status;
  received: number; waiting: number; in_flight: number; done: number;
  out: number; duplicates: number; hits: number; errors: number; records: number;
  skipped: number; // rows passed through because they lacked this step's input
  filtered: number; // rows this step removed on purpose (e.g. ICP misfit, not new)
};
export type RunStats = { stages: StageStats[]; saved: number; records_used: number; max_records: number };

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

const dedupeKey = (item: Item, on: Entity): string | undefined => {
  const v = on === "person" ? item.person?.person_linkedin_url : on === "company" ? item.company?.company_linkedin_url : item.job?.job_posting_url;
  return v ? (on === "job" ? String(v) : normUrl(String(v))) : undefined;
};

/** Does the item carry the record a step needs (with its LinkedIn URL)? */
const hasInput = (item: Item, need: Entity) =>
  need === "person" ? !!item.person?.person_linkedin_url
  : need === "company" ? !!item.company?.company_linkedin_url
  : !!item.job;

class Stage {
  queue: Item[] = [];
  active = new Set<Promise<void>>();
  loggedErrors = new Set<string>();
  stats: StageStats;
  constructor(readonly def: StepDef, readonly params: Rec) {
    this.stats = {
      id: def.id, label: def.label, group: def.group, dedupe_on: def.dedupeOn ?? null, status: "running",
      received: 0, waiting: 0, in_flight: 0, done: 0, out: 0, duplicates: 0, hits: 0, errors: 0, records: 0, skipped: 0, filtered: 0,
    };
  }
}

export type RunEvent =
  | { type: "stats"; stats: RunStats }
  | { type: "row"; row: Rec }
  | { type: "log"; at: number; stage: string; message: string }
  | { type: "finished"; status: Status; error?: string };

export class Run extends EventEmitter {
  readonly id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + randomUUID().slice(0, 4);
  readonly startedAt = Date.now();
  status: Status = "running";
  /** Cursor after the last page fetched (null = search exhausted, undefined = never paged). */
  lastCursor: string | null | undefined;
  error?: string;
  readonly history: RunEvent[] = [];
  private stages: Stage[];
  private stopped = false;
  private sourceDone = false;
  private saved = 0;
  private recordsUsed = 0;
  private seen = new Map<Entity, Set<string>>([["person", new Set()], ["company", new Set()], ["job", new Set()]]);
  private resolveDone!: () => void;
  private allDone = new Promise<void>((r) => (this.resolveDone = r));

  constructor(private client: BlitzAPI, private opts: RunOptions) {
    super();
    this.setMaxListeners(100);
    this.stages = opts.steps.map((s) => new Stage(STEP_BY_ID.get(s.step)!, s.params ?? {}));
  }

  stop(reason = "Stop requested") {
    if (this.stopped) return;
    this.stopped = true;
    this.log("run", `${reason}. No new API calls; saving what's already collected.`);
  }

  async start() {
    this.log("run", `Started: ${this.stages.map((s) => s.def.label).join(" → ")} → Save`);
    const src = this.stages[0];
    try {
      for await (const item of src.def.source!(src.params, this.ctx(0))) {
        src.stats.received++;
        src.stats.done++;
        this.emitFrom(0, item);
        if (this.stopped) break;
      }
      this.sourceDone = true;
      src.stats.status = this.stopped ? "stopped" : "done";
      this.log(src.def.label, `Finished: ${src.stats.out} passed on`);
      this.checkDone();
      await this.allDone;
      this.finish(this.stopped ? "stopped" : "done");
    } catch (e) {
      this.sourceDone = true;
      this.stopped = true;
      src.stats.status = "error";
      src.stats.errors++;
      this.log(src.def.label, `Failed: ${describeError(e)}`);
      this.checkDone();
      await this.allDone;
      this.finish("error", describeError(e));
    }
  }

  /** Context handed to step code, bound to stage i. */
  private ctx(i: number): StepCtx {
    const stage = this.stages[i];
    return {
      client: this.client,
      stopped: () => this.stopped,
      charge: (resp) => {
        const n = Number((resp as { fair_usage?: { records_used?: number } })?.fair_usage?.records_used ?? 0);
        stage.stats.records += n;
        this.recordsUsed += n;
        if (this.recordsUsed >= this.opts.maxRecords) this.stop(`Record budget of ${this.opts.maxRecords} reached`);
      },
      hit: () => { stage.stats.hits++; },
      log: (m) => this.log(stage.def.label, m),
      maxItems: this.opts.maxItems > 0 ? this.opts.maxItems : Infinity,
      startCursor: i === 0 ? this.opts.startCursor : undefined,
      saveCursor: (c) => { this.lastCursor = c; this.opts.onCursor?.(c); },
      concurrency: this.opts.concurrency,
    };
  }

  /** Item leaves stage i: duplicate check (if this step introduces a record type), then next stage or save. */
  private emitFrom(i: number, item: Item) {
    const stage = this.stages[i];
    const on = stage.def.dedupeOn;
    if (on) {
      const key = dedupeKey(item, on);
      if (key) {
        const skipHistory = !stage.def.noHistorySkip &&
          ((on === "person" && this.opts.skipSeenPeople) || (on === "company" && this.opts.skipSeenCompanies));
        if (this.seen.get(on)!.has(key) || (skipHistory && hasSeen(on, key))) {
          stage.stats.duplicates++;
          this.emitStats();
          return;
        }
        this.seen.get(on)!.add(key);
      }
    }
    stage.stats.out++;
    if (i + 1 < this.stages.length) this.enqueue(i + 1, item);
    else this.save(item);
  }

  private enqueue(i: number, item: Item) {
    const stage = this.stages[i];
    stage.stats.received++;
    stage.queue.push(item);
    this.pump(i);
  }

  private pump(i: number) {
    const stage = this.stages[i];
    const limit = Math.min(this.opts.concurrency, stage.def.maxConcurrency ?? Infinity);
    while (stage.active.size < limit && stage.queue.length) {
      const item = stage.queue.shift()!;
      const task = this.process(i, item).finally(() => {
        stage.active.delete(task);
        stage.stats.done++;
        this.pump(i);
        this.checkDone();
      });
      stage.active.add(task);
    }
    stage.stats.waiting = stage.queue.length;
    stage.stats.in_flight = stage.active.size;
    this.emitStats();
  }

  private async process(i: number, item: Item) {
    const stage = this.stages[i];
    const ctx = this.ctx(i);
    // After a stop, pass items straight through so everything collected still gets saved.
    if (this.stopped) return this.emitFrom(i, item);
    // Row lacks what this step needs (e.g. a company where no person was found):
    // pass it through untouched instead of making a call that can only fail.
    if (stage.def.needs && !hasInput(item, stage.def.needs)) {
      stage.stats.skipped++;
      return this.emitFrom(i, item);
    }
    try {
      if (stage.def.enrich) {
        const keep = await stage.def.enrich(item, stage.params, ctx);
        if (keep === false) { stage.stats.filtered++; return; } // step chose to drop this row
        this.emitFrom(i, item);
      } else {
        let children = 0;
        for await (const child of stage.def.expand!(item, stage.params, ctx)) { children++; this.emitFrom(i, child); }
        if (children === 0) this.emitFrom(i, item); // keep the parent row (e.g. company with no matching people)
      }
    } catch (e) {
      stage.stats.errors++;
      // A bad setting fails the same way for every row: log each distinct error once.
      const msg = describeError(e);
      if (!stage.loggedErrors.has(msg)) {
        stage.loggedErrors.add(msg);
        this.log(stage.def.label, `Error: ${msg}${e instanceof APIStatusError && e.status_code === 422 ? " (check this step's settings; further identical errors are counted, not logged)" : ""}`);
      }
      if (e instanceof InsufficientRecordsError || e instanceof AuthenticationError) this.stop("Fatal API error");
      this.emitFrom(i, item); // keep the row even if this step failed
    }
  }

  private save(item: Item) {
    const row = flatten(item);
    saveRow(this.id, row);
    if (item.person?.person_linkedin_url) markSeen("person", normUrl(String(item.person.person_linkedin_url)), this.id);
    if (item.company?.company_linkedin_url) markSeen("company", normUrl(String(item.company.company_linkedin_url)), this.id);
    this.saved++;
    this.push({ type: "row", row });
    this.emitStats();
  }

  private checkDone() {
    if (!this.sourceDone) return;
    // Stages finish in order: a stage is done once everything before it is done and it's idle.
    for (const [i, s] of this.stages.entries()) {
      if (i === 0) continue;
      const prevDone = this.stages[i - 1].stats.status !== "running";
      if (s.stats.status === "running" && prevDone && s.queue.length === 0 && s.active.size === 0) {
        s.stats.status = this.stopped ? "stopped" : "done";
      }
    }
    if (this.stages.every((s) => s.stats.status !== "running")) this.resolveDone();
    this.emitStats();
  }

  private finish(status: Status, error?: string) {
    this.status = status;
    this.error = error;
    for (const s of this.stages) if (s.stats.status === "running") s.stats.status = status;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.log("run", error ? `Failed after ${secs}s: ${error}` : `${status === "done" ? "Finished" : "Stopped"} in ${secs}s. ${this.saved} rows saved, ${this.recordsUsed} records used`);
    this.emitStats(true);
    this.push({ type: "finished", status, error });
  }

  private lastStats = 0;
  private emitStats(force = false) {
    if (!force && Date.now() - this.lastStats < 120) return;
    this.lastStats = Date.now();
    this.emit("event", { type: "stats", stats: this.snapshot() } satisfies RunEvent);
  }

  snapshot(): RunStats {
    for (const s of this.stages) { s.stats.waiting = s.queue.length; s.stats.in_flight = s.active.size; }
    return { stages: this.stages.map((s) => ({ ...s.stats })), saved: this.saved, records_used: this.recordsUsed, max_records: this.opts.maxRecords };
  }

  private log(stage: string, message: string) {
    this.push({ type: "log", at: Date.now() - this.startedAt, stage, message });
  }

  private push(ev: RunEvent) {
    this.history.push(ev);
    this.emit("event", ev);
  }
}

export function describeError(e: unknown): string {
  if (e instanceof APIStatusError) {
    const body = e.body as { message?: string; errors?: { field: string; message: string }[] } | undefined;
    const details = body?.errors?.map((x) => `${x.field}: ${x.message}`).join("; ");
    return `HTTP ${e.status_code}${body?.message ? ": " + body.message : ""}${details ? " (" + details + ")" : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}
