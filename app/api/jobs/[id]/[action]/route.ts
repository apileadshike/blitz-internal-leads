import { runtime } from "@/lib/runtime";
import { getJob } from "@/lib/jobs";
import { rerunFailed } from "@/lib/engine/runs";
import { exportResponse } from "@/lib/leads";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
// Direct downloads stream for up to 300 s (the most Vercel Hobby allows; Pro could go to 800). Huge ones use /api/exports.
export const maxDuration = 300;

/** Download every row a job has saved, across all its runs (streamed): /api/jobs/:id/rows?fmt=csv|xlsx */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const p = await params;
  const job = await getJob(Number(p.id));
  if (!job || p.action !== "rows") return new Response("Not found", { status: 404 });
  return exportResponse({ jobId: job.id }, job.name, new URL(req.url).searchParams.get("fmt"));
}

/** Buttons on the Jobs page: run, pause, resume, retry, restart, delete. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const p = await params;
  const id = Number(p.id);
  if (!(await getJob(id))) return json({ error: "No such job" }, 404);
  const { scheduler } = runtime();
  let err: string | void = undefined;
  switch (p.action) {
    case "run": err = await scheduler.runNow(id); break;
    case "pause": await scheduler.pause(id); break;
    case "resume": case "retry": await scheduler.resume(id); break;
    case "restart": err = await scheduler.restart(id); break;
    case "rerun": {
      const job = await getJob(id);
      if (!job?.run_id) { err = "This job has no run yet"; break; }
      const r = await rerunFailed(job.run_id);
      if ("error" in r) err = r.error; else if (!r.count) err = "No failed rows to re-run";
      break;
    }
    case "delete": await scheduler.remove(id); break;
    default: return json({ error: "Unknown action" }, 404);
  }
  return err ? json({ error: err }, 409) : json({ ok: true });
}
