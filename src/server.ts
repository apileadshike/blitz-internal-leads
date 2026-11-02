import express from "express";
import { BlitzAPI } from "blitz-api-js";
import { Run, describeError, validateSteps, type RunOptions } from "./pipeline.js";
import { counts, rowsFor } from "./db.js";
import { toCsv, toXlsx } from "./export.js";
import { stepCatalog } from "./schema.js";
import { NON_PIPELINE_ENDPOINTS } from "./steps.js";

try { process.loadEnvFile(".env"); } catch { /* env may come from the shell instead */ }
if (!process.env.BLITZ_API_KEY) {
  console.error("Missing BLITZ_API_KEY. Put it in .env (see .env.example).");
  process.exit(1);
}

// One shared client. Its rate limiter is per endpoint, so every step gets
// its own requests-per-second budget and steps never slow each other down.
const client = new BlitzAPI({
  api_key: process.env.BLITZ_API_KEY,
  rate_limit_rps: Number(process.env.BLITZ_RPS ?? 10),
  max_retries: 4,
});

const catalog = stepCatalog();
const runs = new Map<string, Run>();
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

app.get("/api/meta", async (_req, res) => {
  let account: unknown;
  try { account = await client.account.key_info(); } catch (e) { account = { error: describeError(e) }; }
  res.json({ account, db: counts(), not_pipeline: NON_PIPELINE_ENDPOINTS });
});

app.get("/api/steps", (_req, res) => res.json(catalog));

app.post("/api/runs", (req, res) => {
  const b = req.body as Partial<RunOptions>;
  const steps = Array.isArray(b.steps) ? b.steps : [];
  const err = validateSteps(steps);
  if (err) return void res.status(400).json({ error: err });
  const opts: RunOptions = {
    steps,
    // 0 = everything the filter matches (Blitz stops a single search at 50,000)
    maxItems: b.maxItems === 0 ? 0 : clamp(b.maxItems, 20, 1, 50_000),
    concurrency: clamp(b.concurrency, 20, 1, 50),
    maxRecords: clamp(b.maxRecords, 1000, 1, 10_000_000),
    skipSeenPeople: b.skipSeenPeople !== false,
    skipSeenCompanies: b.skipSeenCompanies === true,
  };
  const run = new Run(client, opts);
  runs.set(run.id, run);
  void run.start();
  res.json({ id: run.id });
});

// Live progress (Server-Sent Events). Late joiners get the full history replayed.
app.get("/api/runs/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return void res.status(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: "stats", stats: run.snapshot() });
  for (const ev of run.history) send(ev);
  run.on("event", send);
  req.on("close", () => run.off("event", send));
});

app.post("/api/runs/:id/stop", (req, res) => {
  runs.get(req.params.id)?.stop();
  res.json({ ok: true });
});

app.get("/api/runs/:id/rows.:fmt", (req, res) => sendRows(res, rowsFor(req.params.id), `leads-${req.params.id}`, req.params.fmt));
app.get("/api/rows.:fmt", (req, res) => sendRows(res, rowsFor(), "all-leads", req.params.fmt));

async function sendRows(res: express.Response, rows: ReturnType<typeof rowsFor>, name: string, fmt: string) {
  if (fmt === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
    res.send(await toXlsx(rows));
  } else {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
    res.send(toCsv(rows));
  }
}

function clamp(v: unknown, dflt: number, lo: number, hi: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Blitz Lead Engine → http://localhost:${port}`));
