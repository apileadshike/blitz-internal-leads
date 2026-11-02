"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./header";

type Job = {
  id: number; name: string; file: string; status: string; position: number;
  pages: number; rows: number; records: number; records_total: number;
  record_budget: number | null; batch_size: number | null; repeat_every_hours: number | null;
  batches: number; cycles: number; search_done: boolean; has_progress: boolean; steps: string[];
  next_run_at: string | null; note: string | null; error: string | null;
  run_id: string | null; live: boolean; stopping: boolean; started_at: string | null; finished_at: string | null;
  failed: number; retries: number;
};
type Settings = { enabled: boolean; max_parallel: number; daily_budget: number };
type JobsData = { jobs: Job[]; settings: Settings; spent_today: number; running: number; alerts: { at: string; level: string; text: string }[]; jobs_dir: string };

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

export function JobsPage() {
  const [data, setData] = useState<JobsData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [order, setOrder] = useState<Job[] | null>(null); // local order while dragging
  const [busy, setBusy] = useState<string | null>(null);
  const dragging = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (dragging.current !== null) return;
    try {
      const d: JobsData = await (await fetch("/api/jobs")).json();
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
    if (action === "delete" && !confirm("Delete this job? Its file moves to jobs/_deleted/ (split files: all parts). Rows already saved stay in the database.")) return;
    if (action === "restart" && !confirm("Start this job over from the first page? Results bought again cost records again (people already saved are skipped if 'skip seen people' is on).")) return;
    setBusy(`${job.id}:${action}`);
    const r = await post(`/api/jobs/${job.id}/${action}`);
    if (!r.ok) alert((await r.json()).error);
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
  return (
    <>
      <Header active="jobs" right={s && data && (
        <div className="muted">Today (UTC): {n(data.spent_today)} / {n(s.daily_budget)} records · {data.running} running{s.enabled ? "" : " · queue OFF"}</div>
      )} />
      <main className="single">
        <section className="panel">
          <div className="row between">
            <h2>Queue</h2>
            {settings && (
              <div className="queue-settings">
                <label className="inline"><input type="checkbox" checked={settings.enabled} onChange={(e) => saveSettings({ ...settings, enabled: e.target.checked })} /> Queue on</label>
                <label>Jobs at the same time
                  <input type="number" min={1} max={10} defaultValue={settings.max_parallel} onBlur={(e) => saveSettings({ ...settings, max_parallel: Number(e.target.value) })} />
                </label>
                <label>Daily record budget
                  <input type="number" min={1} defaultValue={settings.daily_budget} onBlur={(e) => saveSettings({ ...settings, daily_budget: Number(e.target.value) })} />
                </label>
              </div>
            )}
          </div>
          <div className="budget-bar"><div style={{ width: s ? Math.min(100, (100 * (data?.spent_today ?? 0)) / s.daily_budget) + "%" : 0 }} /></div>
          <p className="hint">
            Jobs run top to bottom. Drag rows to reorder. Each job keeps going until its search has no more results, then the next one starts.
            Drop a <code>.json</code> file into the <code>{data?.jobs_dir ?? "jobs"}/</code> folder, or use <b>Save as job</b> in the builder.
          </p>
          <div className="table-wrap">
            <table className="jobs">
              <thead><tr><th></th><th>Job</th><th>Status</th><th>Progress</th><th>Records</th><th>Last activity</th><th>Actions</th></tr></thead>
              <tbody>
                {!data ? (
                  <tr className="empty"><td colSpan={7}>Loading…</td></tr>
                ) : jobs.length === 0 ? (
                  <tr className="empty"><td colSpan={7}>No jobs yet. Build a pipeline and press <b>Save as job</b>, or drop a file into the jobs folder.</td></tr>
                ) : jobs.map((j, i) => {
                  const status = j.live && j.stopping ? "stopping" : j.status;
                  const due = j.status === "waiting" && j.next_run_at && new Date(j.next_run_at) > new Date() ? `next run ${ago(j.next_run_at)}` : "";
                  const pct = j.record_budget ? Math.min(100, (100 * j.records) / j.record_budget) : 0;
                  const btn = (action: string, label: string, cls = "secondary small") => (
                    <button className={cls} disabled={busy === `${j.id}:${action}`} onClick={() => act(j, action)}>{label}</button>
                  );
                  return (
                    <tr key={j.id} draggable className={dragging.current === j.id ? "dragging" : undefined}
                      onDragStart={() => { dragging.current = j.id; }} onDragOver={(e) => onDragOver(e, j.id)} onDragEnd={onDragEnd}>
                      <td className="grip" title="Drag to reorder">⋮⋮ {i + 1}</td>
                      <td>
                        <b>{j.name}</b>
                        <div className="muted">{j.file} · {j.steps.join(" → ")}{j.repeat_every_hours ? ` · repeats every ${j.repeat_every_hours}h` : ""}</div>
                      </td>
                      <td><span className={"pill " + status}>{status}</span>{due && <div className="muted">{due}</div>}</td>
                      <td>
                        {n(j.pages)} pages · {n(j.rows)} rows
                        <div className="muted">{n(j.batches)} batches{j.cycles ? ` · ${j.cycles} cycles` : ""}{j.search_done ? " · search fully read" : ""}</div>
                      </td>
                      <td>
                        {n(j.records)}{j.record_budget ? ` / ${n(j.record_budget)}` : ""}
                        <div className="mini-bar"><div style={{ width: pct + "%" }} /></div>
                        {j.records_total !== j.records && <div className="muted">{n(j.records_total)} all time</div>}
                      </td>
                      <td>
                        {j.error ? <span className="error">{j.error}</span> : j.note}
                        {j.failed > 0 && <div className="error">{j.failed} lead(s) with a failed step</div>}
                        <div className="muted">{j.live ? "started " + ago(j.started_at) : j.finished_at ? "finished " + ago(j.finished_at) : ""}</div>
                      </td>
                      <td className="job-actions">
                        {!j.live && btn("run", "▶ Run now", "small")}
                        {j.live && !j.stopping && btn("pause", "Pause")}
                        {!j.live && j.status === "waiting" && btn("pause", "Pause")}
                        {j.status === "paused" && btn("resume", "Resume")}
                        {j.status === "failed" && btn("retry", "Retry")}
                        {!j.live && j.failed > 0 && btn("rerun", `↻ Re-run failed (${j.failed})`)}
                        {!j.live && (j.has_progress || j.search_done) && btn("restart", "Start over")}
                        {j.live && j.run_id && <a className="btn secondary small" href={`/#run=${j.run_id}`} target="_blank">Watch</a>}
                        {j.rows > 0 && (
                          <>
                            <a className="btn secondary small" href={`/api/jobs/${j.id}/rows?fmt=csv`}>CSV</a>
                            <a className="btn secondary small" href={`/api/jobs/${j.id}/rows?fmt=xlsx`}>Excel</a>
                          </>
                        )}
                        {btn("delete", "Delete", "link")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <h2>Alerts</h2>
          <ol className="alerts">
            {data?.alerts.length
              ? data.alerts.map((a, i) => <li key={i} className={a.level}><span className="muted">{ago(a.at)}</span> {a.text}</li>)
              : <li className="muted">Nothing yet.</li>}
          </ol>
          <details>
            <summary>Job file format</summary>
            <pre>{`{
  "name": "SaaS founders US",
  "steps": [ { "step": "people_search", "params": { … filters … } }, { "step": "find_email" } ],
  "batch_size": 1000,          // search results per batch (progress is saved after every page)
  "record_budget": 5000,       // max records this job may spend (per cycle)
  "workers": 20,
  "skip_seen_people": true,
  "skip_seen_companies": false,
  "repeat_every_hours": 24,    // optional: run again after finishing (pair with "Only new since last run")
  "split": {                   // optional: one job per value, for filters over 50,000 results
    "field": "company.hq.country_code",
    "values": ["US", "GB", "DE"]
  }
}`}</pre>
            <p className="hint">Easiest way to get the steps right: build the pipeline in the builder and press <b>Save as job</b>, then edit the file.
              Changing budget, workers or repeat keeps progress. Changing steps or filters starts the job over.</p>
          </details>
        </section>
      </main>
    </>
  );
}
