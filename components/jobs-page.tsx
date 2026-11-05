"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { dialog } from "./dialog";

type Job = {
  id: number; name: string; file: string; status: string; position: number;
  pages: number; rows: number; records: number; records_total: number;
  record_budget: number | null; batch_size: number | null; repeat_every_hours: number | null; max_results?: number;
  batches: number; cycles: number; search_done: boolean; has_progress: boolean; steps: string[];
  next_run_at: string | null; note: string | null; error: string | null;
  run_id: string | null; live: boolean; stopping: boolean; started_at: string | null; finished_at: string | null;
  failed: number; retries: number;
};
type Settings = { enabled: boolean; max_parallel: number; daily_budget: number };
type JobsData = { jobs: Job[]; settings: Settings; spent_today: number; running: number; alerts: { at: string; level: string; text: string }[]; jobs_dir: string; worker_seen?: string | null };

const n = (v: number | null | undefined) => Number(v ?? 0).toLocaleString();
function ago(iso: string | null) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const a = Math.abs(s);
  const t = a < 60 ? `${Math.round(a)}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${(a / 3600).toFixed(1)}h` : `${(a / 86400).toFixed(1)}d`;
  return s < 0 ? `in ${t}` : `${t} ago`;
}
const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Label on a button while its action runs. */
const PENDING: Record<string, string> = {
  run: "Starting…", pause: "Pausing…", resume: "Resuming…", retry: "Retrying…", restart: "Restarting…",
  rerun: "Re-running…", delete: "Deleting…",
};
/** How a job looks right after a click, before the server confirms (null = gone). */
const OPTIMISTIC: Record<string, (j: Job) => Partial<Job> | null> = {
  run: () => ({ status: "running", note: "Starting…", error: null }),
  pause: (j) => (j.live ? { stopping: true } : { status: "paused" }),
  resume: () => ({ status: "waiting", error: null }),
  retry: () => ({ status: "waiting", error: null }),
  restart: () => ({ status: "waiting", error: null, rows: 0, pages: 0, records: 0 }),
  delete: () => null,
};

export function JobsPage() {
  const [data, setData] = useState<JobsData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [order, setOrder] = useState<Job[] | null>(null); // local order while dragging
  const [busy, setBusy] = useState<string | null>(null);
  const dragging = useRef<number | null>(null);

  // Bumped by every button click: a refresh that started before the click is thrown away,
  // so it can't undo the change the click just showed.
  const actions = useRef(0);
  const load = useCallback(async () => {
    if (dragging.current !== null) return;
    const seq = actions.current;
    try {
      const d: JobsData = await (await fetch("/api/jobs")).json();
      if (seq !== actions.current) return;
      setData(d);
      setSettings((s) => s ?? d.settings);
    } catch { /* server restarting */ }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (job: Job, action: string) => {
    if (action === "delete" && !(await dialog.confirm({
      title: `Delete "${job.name}"?`, message: "The job is removed from the queue. Leads it already saved stay in your database.",
      confirmLabel: "Delete job", danger: true,
    }))) return;
    if (action === "restart" && !(await dialog.confirm({
      title: `Start "${job.name}" over?`,
      message: "It begins again from the first page. Results bought again cost records again (people already saved are skipped if Skip people already in my database is on).",
      confirmLabel: "Start over",
    }))) return;
    setBusy(`${job.id}:${action}`);
    actions.current++;
    // Show the result at once; the refresh right after the request confirms it.
    const patch = OPTIMISTIC[action]?.(job);
    if (patch !== undefined) {
      setData((d) => d && {
        ...d,
        jobs: patch === null ? d.jobs.filter((x) => x.id !== job.id) : d.jobs.map((x) => (x.id === job.id ? { ...x, ...patch } : x)),
      });
    }
    const r = await post(`/api/jobs/${job.id}/${action}`).catch(() => null);
    actions.current++;
    if (!r?.ok) void dialog.alert("That didn't work", r ? (await r.json().catch(() => ({}))).error ?? "The server didn't answer." : "The server didn't answer.");
    setBusy(null);
    load();
  };

  const saveSettings = async (next: Settings) => {
    setSettings(next);
    await post("/api/jobs/settings", next);
    load();
  };

  // Drag to reorder
  const jobs = order ?? data?.jobs ?? [];
  const onDragOver = (e: React.DragEvent, overId: number) => {
    e.preventDefault();
    const from = dragging.current;
    if (from === null || from === overId) return;
    const list = [...jobs];
    const a = list.findIndex((j) => j.id === from), b = list.findIndex((j) => j.id === overId);
    list.splice(b, 0, list.splice(a, 1)[0]);
    setOrder(list);
  };
  const onDragEnd = async () => {
    const ids = jobs.map((j) => j.id);
    await post("/api/jobs/order", { ids });
    dragging.current = null;
    setOrder(null);
    load();
  };

  const s = data?.settings;
  const offline = !!data && data.worker_seen !== undefined && (!data.worker_seen || Date.now() - Date.parse(data.worker_seen) > 60_000);
  const spentPct = s ? Math.min(100, (100 * (data?.spent_today ?? 0)) / s.daily_budget) : 0;
  return (
    <>
      <Header active="jobs" right={s && data && (
        <div className="stat-chips">
          <span className="stat-chip">{offline ? <span className="dead" /> : <span className="live" />}Worker {offline ? "offline" : "online"}</span>
          <span className="stat-chip"><b>{data.running}</b> running</span>
        </div>
      )} />
      <main className="single">
        <div className="page-head">
          <div>
            <h2>Jobs</h2>
            <p>Background pipelines. They run top to bottom, keep going when this page is closed, and stop at their record budget.</p>
          </div>
          {settings && (
            <label className="switch inline-switch">
              <input type="checkbox" checked={settings.enabled} onChange={(e) => saveSettings({ ...settings, enabled: e.target.checked })} />
              <span>Queue {settings.enabled ? "on" : "off"}</span>
            </label>
          )}
        </div>

        {offline && (
          <div className="banner warn">
            <b>The worker is offline</b>{data?.worker_seen ? ` (last seen ${ago(data.worker_seen)})` : ""}. Jobs wait in the queue and continue as soon as it is back.
          </div>
        )}

        <section className="metrics big-metrics">
          <div className="metric">
            <span>Spent today (UTC)</span>
            <b>{n(data?.spent_today)}</b>
            <small>of {n(s?.daily_budget)} daily records</small>
            <div className="budget-bar"><div style={{ width: spentPct + "%" }} /></div>
          </div>
          <div className="metric"><span>Running now</span><b>{n(data?.running)}</b><small>up to {n(s?.max_parallel)} at the same time</small></div>
          <div className="metric"><span>Jobs</span><b>{n(data?.jobs.length)}</b><small>{n(data?.jobs.filter((j) => j.status === "waiting").length)} waiting</small></div>
          <div className="metric">
            <span>Queue settings</span>
            {settings && (
              <div className="metric-inputs">
                <label>Parallel jobs
                  <input type="number" min={1} max={10} defaultValue={settings.max_parallel} onBlur={(e) => saveSettings({ ...settings, max_parallel: Number(e.target.value) })} />
                </label>
                <label>Daily budget
                  <input type="number" min={1} defaultValue={settings.daily_budget} onBlur={(e) => saveSettings({ ...settings, daily_budget: Number(e.target.value) })} />
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="job-list">
          {!data ? (
            <div className="empty-state"><b>Loading jobs…</b></div>
          ) : jobs.length === 0 ? (
            <div className="empty-state"><b>No jobs yet</b>Build a pipeline in the builder and press Create job.</div>
          ) : jobs.map((j, i) => {
            const status = j.live && j.stopping ? "stopping" : j.status;
            const due = j.status === "waiting" && j.next_run_at && new Date(j.next_run_at) > new Date() ? `next run ${ago(j.next_run_at)}` : "";
            const pct = j.record_budget ? Math.min(100, (100 * j.records) / j.record_budget) : 0;
            const mine = busy?.startsWith(`${j.id}:`);
            const btn = (action: string, label: string, cls = "secondary small") => (
              <button className={cls} disabled={mine} onClick={() => void act(j, action)}>
                {busy === `${j.id}:${action}` ? PENDING[action] ?? "Working…" : label}
              </button>
            );
            return (
              <article key={j.id} draggable className={"job-card " + status + (dragging.current === j.id ? " dragging" : "")}
                onDragStart={() => { dragging.current = j.id; }} onDragOver={(e) => onDragOver(e, j.id)} onDragEnd={onDragEnd}>
                <div className="job-grip" title="Drag to reorder">{i + 1}</div>
                <div className="job-main">
                  <div className="job-title">
                    <b>{j.name}</b>
                    <span className={"pill " + status}>{j.live && !j.stopping && <span className="pulse-dot" />}{status}</span>
                    {due && <span className="muted">{due}</span>}
                  </div>
                  <div className="job-steps">
                    {j.steps.map((st, k) => <span key={k} className="step-chip">{st}</span>)}
                    <span className="muted">{j.max_results ? `max ${j.max_results.toLocaleString()} results` : "all results"}{j.repeat_every_hours ? ` · repeats every ${j.repeat_every_hours}h` : ""}</span>
                  </div>
                  <div className="job-stats">
                    <div><span>Leads</span><b>{n(j.rows)}</b></div>
                    <div><span>Pages</span><b>{n(j.pages)}</b></div>
                    <div className="job-budget">
                      <span>Records{j.record_budget ? ` · ${Math.round(pct)}% of budget` : ""}</span>
                      <b>{n(j.records)}{j.record_budget ? <small> / {n(j.record_budget)}</small> : null}</b>
                      {j.record_budget ? <div className="budget-bar"><div style={{ width: pct + "%" }} /></div> : null}
                    </div>
                    <div><span>{j.live ? "Started" : j.finished_at ? "Finished" : "Activity"}</span><b className="soft">{j.live ? ago(j.started_at) : j.finished_at ? ago(j.finished_at) : "–"}</b></div>
                  </div>
                  {(j.error || j.note || j.failed > 0) && (
                    <div className={"job-note" + (j.error ? " err" : "")}>
                      {j.error ?? j.note}
                      {j.failed > 0 && <>{j.error || j.note ? " · " : ""}{j.failed} lead(s) with a failed step</>}
                    </div>
                  )}
                </div>
                <div className="job-actions">
                  {!j.live && btn("run", "Run now", "small")}
                  {j.live && !j.stopping && btn("pause", "Pause")}
                  {!j.live && j.status === "waiting" && btn("pause", "Pause")}
                  {j.status === "paused" && btn("resume", "Resume")}
                  {j.status === "failed" && btn("retry", "Retry")}
                  {!j.live && j.failed > 0 && btn("rerun", `Re-run failed (${j.failed})`)}
                  {!j.live && (j.has_progress || j.search_done) && btn("restart", "Start over")}
                  {j.live && j.run_id && <a className="btn secondary small" href={`/#run=${j.run_id}`} target="_blank">Watch live</a>}
                  {j.rows > 0 && (
                    <div className="dl">
                      <a className="btn ghost small" href={`/api/jobs/${j.id}/rows?fmt=csv`}>CSV</a>
                      <a className="btn ghost small" href={`/api/jobs/${j.id}/rows?fmt=xlsx`}>Excel</a>
                    </div>
                  )}
                  {btn("delete", "Delete", "link")}
                </div>
              </article>
            );
          })}
        </section>

        <section className="panel">
          <div className="panel-h"><h2>Alerts</h2></div>
          <ol className="alerts">
            {data?.alerts.length
              ? data.alerts.map((a, i) => <li key={i} className={a.level}><span className="muted">{ago(a.at)}</span> {a.text}</li>)
              : <li className="muted">Nothing yet.</li>}
          </ol>
        </section>
      </main>
    </>
  );
}
