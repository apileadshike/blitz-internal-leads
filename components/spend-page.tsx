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

  const saved = d ? d.byDay.reduce((a, x) => a + (x.saved ?? 0), 0) : 0;
  return (
    <>
      <Header active="spend" right={null} />
      <main className="single">
        <div className="page-head">
          <div>
            <h2>Spend</h2>
            <p>Records used by every builder run and job. Lookups that find nothing are free, so &quot;found&quot; is what you pay for.</p>
          </div>
          <div className="tabs">
            {[7, 30, 90].map((x) => (
              <button key={x} type="button" className={"tab" + (days === x ? " on" : "")} onClick={() => setDays(x)}>{x} days</button>
            ))}
          </div>
        </div>

        {!d ? <div className="empty-state"><b>Loading…</b></div> : (
          <>
            <section className="metrics big-metrics">
              <div className="metric"><span>Today (UTC)</span><b>{n(d.totals.today)}</b><small>records</small></div>
              <div className="metric"><span>Last 7 days</span><b>{n(d.totals.week)}</b><small>records</small></div>
              <div className="metric"><span>Last {d.days} days</span><b>{n(d.totals.period)}</b><small>{n(saved)} leads saved</small></div>
              <div className="metric"><span>Cost per lead</span><b>{saved ? (d.totals.period / saved).toFixed(1) : "–"}</b><small>records per saved lead</small></div>
            </section>

            <section className="panel">
              <div className="panel-h">
                <div>
                  <h2>Records used per day</h2>
                  <div className="sub">UTC days, last {d.days} days. Hover a bar for details.</div>
                </div>
              </div>
              <DayChart days={d.days} rows={d.byDay} />
            </section>

            <div className="two-col">
              <section className="panel">
                <div className="panel-h"><h2>By step</h2></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Step</th><th>Records</th><th>Processed</th><th>Hit rate</th><th>Cache (free)</th><th>Errors</th></tr></thead>
                    <tbody>
                      {d.byStep.length === 0 ? <tr className="empty"><td colSpan={6}>No runs in this period.</td></tr> : d.byStep.map((s) => {
                        const hit = s.done ? Math.round((100 * (s.hits ?? 0)) / s.done) : null;
                        return (
                          <tr key={s.step}>
                            <td><b>{s.label}</b></td><td>{n(s.records)}</td><td>{n(s.done)}</td>
                            <td>{hit === null ? "–" : <div className="rate"><div className="mini-bar"><div style={{ width: hit + "%" }} /></div>{hit}%</div>}</td>
                            <td>{n(s.cached)}</td>
                            <td className={s.errors ? "error" : "soft"}>{n(s.errors)}{s.errors ? ` (${pct(s.errors, s.done)})` : ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="panel">
                <div className="panel-h"><h2>By job</h2></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Job</th><th>Records</th><th>Leads</th><th>Per lead</th><th>Runs</th></tr></thead>
                    <tbody>
                      {d.byJob.length === 0 ? <tr className="empty"><td colSpan={5}>No runs in this period.</td></tr> : d.byJob.map((j) => (
                        <tr key={String(j.job_id)}>
                          <td><b>{j.name}</b></td><td>{n(j.records)}</td><td>{n(j.saved)}</td>
                          <td>{j.saved ? (j.records / j.saved).toFixed(1) : "–"}</td><td>{n(j.runs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <section className="panel">
              <details>
                <summary className="table-toggle">Show the daily numbers as a table</summary>
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table>
                    <thead><tr><th>Day (UTC)</th><th>Records</th><th>Leads saved</th><th>Lookups</th><th>Errors</th><th>Runs</th></tr></thead>
                    <tbody>
                      {d.byDay.length === 0 ? <tr className="empty"><td colSpan={6}>No runs in this period.</td></tr> : d.byDay.map((x) => (
                        <tr key={x.day}>
                          <td>{x.day}</td><td><b>{n(x.records)}</b></td><td>{n(x.saved)}</td><td>{n(x.done)}</td>
                          <td className={x.errors ? "error" : undefined}>{n(x.errors)}</td><td>{n(x.runs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          </>
        )}
      </main>
    </>
  );
}

/** A clean round number at or above v (1, 2, 5 × 10^k) for the top of the axis. */
function niceMax(v: number) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}
const tick = (v: number) => (v >= 10_000 ? `${Math.round(v / 1000)}K` : v.toLocaleString());

/** Records per UTC day: one column per day (empty days included), hover shows the day's numbers. */
function DayChart({ days, rows }: { days: number; rows: Spend["byDay"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    return { day, records: r?.records ?? 0, saved: r?.saved ?? 0, runs: r?.runs ?? 0 };
  });
  const top = niceMax(Math.max(...series.map((x) => x.records)));
  const ticks = [top, top / 2, 0];
  const h = hover === null ? null : series[hover];
  const label = (day: string) => new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const every = Math.ceil(days / 8); // about 8 date labels along the bottom
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <div className="chart-y">{ticks.map((t) => <span key={t}>{tick(t)}</span>)}</div>
      <div className="chart-plot">
        {ticks.map((t) => <div key={t} className="grid" style={{ bottom: `${(t / top) * 100}%` }} />)}
        <div className="bars">
          {series.map((x, i) => (
            <div key={x.day} className={"bar-slot" + (hover === i ? " on" : "")} onMouseEnter={() => setHover(i)}>
              <div className="bar" style={{ height: `${(x.records / top) * 100}%` }} />
            </div>
          ))}
        </div>
        {h && hover !== null && (
          <div className="tip" style={{ left: `${((hover + 0.5) / days) * 100}%` }}>
            <b>{label(h.day)}</b>
            <span>{h.records.toLocaleString()} records</span>
            <span>{h.saved.toLocaleString()} leads saved · {h.runs} run{h.runs === 1 ? "" : "s"}</span>
          </div>
        )}
        <div className="chart-x">
          {series.map((x, i) => <span key={x.day}>{i % every === 0 ? label(x.day) : ""}</span>)}
        </div>
      </div>
    </div>
  );
}
