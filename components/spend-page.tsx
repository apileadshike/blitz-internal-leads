"use client";
// Where the records went: totals, per day, per step and per job, with error rates.
import { useEffect, useState } from "react";
import { Header } from "./header";

type Line = { records: number; done?: number; hits?: number; errors?: number; saved?: number; runs?: number; cached?: number };
type Spend = {
  days: number;
  totals: { today: number; week: number; period: number };
  byDay: (Line & { day: string })[];
  byStep: (Line & { step: string; label: string })[];
  byJob: (Line & { job_id: number | null; name: string })[];
};

const n = (v?: number) => Number(v ?? 0).toLocaleString();
const pct = (part?: number, whole?: number) => (whole ? `${Math.round((100 * (part ?? 0)) / whole)}%` : "–");

export function SpendPage() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Spend | null>(null);
  useEffect(() => { fetch(`/api/spend?days=${days}`).then((r) => r.json()).then(setD); }, [days]);

  return (
    <>
      <Header active="spend" right={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      } />
      <main className="single">
        {!d ? <section className="panel"><p className="muted">Loading…</p></section> : (
          <>
            <section className="panel">
              <div className="spend-totals">
                <div><span className="muted">Today (UTC)</span><b>{n(d.totals.today)}</b></div>
                <div><span className="muted">Last 7 days</span><b>{n(d.totals.week)}</b></div>
                <div><span className="muted">Last {d.days} days</span><b>{n(d.totals.period)}</b></div>
              </div>
              <p className="hint">Records used, from every builder run and job. Lookups that find nothing are free, so &quot;found&quot; is what you pay for.</p>
            </section>

            <section className="panel">
              <h2>By step</h2>
              <table>
                <thead><tr><th>Step</th><th>Records</th><th>Processed</th><th>Found</th><th>Hit rate</th><th>From cache (free)</th><th>Errors</th><th>Error rate</th></tr></thead>
                <tbody>
                  {d.byStep.length === 0 ? <tr className="empty"><td colSpan={8}>No runs in this period.</td></tr> : d.byStep.map((s) => (
                    <tr key={s.step}>
                      <td>{s.label}</td><td><b>{n(s.records)}</b></td><td>{n(s.done)}</td><td>{n(s.hits)}</td>
                      <td>{pct(s.hits, s.done)}</td><td>{n(s.cached)}</td><td className={s.errors ? "error" : undefined}>{n(s.errors)}</td><td>{pct(s.errors, s.done)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="panel">
              <h2>By job</h2>
              <table>
                <thead><tr><th>Job</th><th>Records</th><th>Rows saved</th><th>Records per row</th><th>Runs</th></tr></thead>
                <tbody>
                  {d.byJob.length === 0 ? <tr className="empty"><td colSpan={5}>No runs in this period.</td></tr> : d.byJob.map((j) => (
                    <tr key={String(j.job_id)}>
                      <td>{j.name}</td><td><b>{n(j.records)}</b></td><td>{n(j.saved)}</td>
                      <td>{j.saved ? (j.records / j.saved).toFixed(1) : "–"}</td><td>{n(j.runs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="panel">
              <h2>By day</h2>
              <table>
                <thead><tr><th>Day (UTC)</th><th>Records</th><th>Rows saved</th><th>Lookups</th><th>Errors</th><th>Runs</th></tr></thead>
                <tbody>
                  {d.byDay.length === 0 ? <tr className="empty"><td colSpan={6}>No runs in this period.</td></tr> : d.byDay.map((x) => (
                    <tr key={x.day}>
                      <td>{x.day}</td><td><b>{n(x.records)}</b></td><td>{n(x.saved)}</td><td>{n(x.done)}</td>
                      <td className={x.errors ? "error" : undefined}>{n(x.errors)}</td><td>{n(x.runs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
    </>
  );
}
