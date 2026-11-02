"use client";
// Every saved lead, paged and filterable, read straight from the database.
import { useEffect, useMemo, useState } from "react";
import { Header } from "./header";
import { humanize } from "./schema-form";

type Row = Record<string, any>;
const COLS = ["full_name", "job_title", "email", "phone", "company_name", "company_domain", "country",
  "company_industry", "company_size", "failed_step", "person_linkedin_url", "company_linkedin_url", "saved_at"];

export function LeadsPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // applied search (after typing pauses)
  const [hasEmail, setHasEmail] = useState(false);
  const [hasPhone, setHasPhone] = useState(false);
  const [country, setCountry] = useState("");
  const [job, setJob] = useState("");
  const [jobs, setJobs] = useState<{ id: number; name: string }[]>([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; exact: boolean; hasMore: boolean; size: number; backgroundExports?: boolean } | null>(null);
  const [exp, setExp] = useState<{ status: string; rows?: number | null; url?: string | null; error?: string | null } | null>(null);

  /** Big downloads are built in the background and stored in Supabase; we poll until the link is ready. */
  async function backgroundExport(fmt: "csv" | "xlsx") {
    setExp({ status: "queued" });
    const r = await fetch(`/api/exports?${params}&fmt=${fmt}&name=leads`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) return setExp({ status: "failed", error: j.error });
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await (await fetch(`/api/exports/${j.id}`)).json();
      setExp(s);
      if (s.status === "done" || s.status === "failed") break;
    }
  }
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/jobs").then((r) => r.json()).then((d) => setJobs(d.jobs.map((j: any) => ({ id: j.id, name: j.name })))).catch(() => {});
  }, []);
  useEffect(() => { const t = setTimeout(() => { setQuery(q); setPage(1); }, 350); return () => clearTimeout(t); }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (hasEmail) p.set("has_email", "1");
    if (hasPhone) p.set("has_phone", "1");
    if (country) p.set("country", country);
    if (job) p.set("job", job);
    return p;
  }, [query, hasEmail, hasPhone, country, job]);

  useEffect(() => {
    const p = new URLSearchParams(params);
    p.set("page", String(page));
    setLoading(true);
    fetch(`/api/leads?${p}`).then((r) => r.json()).then(setData).finally(() => setLoading(false));
  }, [params, page]);

  // Exact page count up to 10,000 matches; beyond that, "Next" works as long as there is more.
  const pages = data?.exact ? Math.max(1, Math.ceil(data.total / data.size)) : null;
  const countText = data ? `${data.total.toLocaleString()}${data.exact ? "" : "+"} leads match` : "";
  const cols = useMemo(() => {
    const rows = data?.rows ?? [];
    const fromFile = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k.startsWith("in_"))))].slice(0, 3);
    return [...fromFile, ...COLS.filter((c) => rows.some((r) => r[c] !== undefined && r[c] !== ""))];
  }, [data]);
  const resetPage = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <>
      <Header active="leads" right={<div className="muted">{countText}</div>} />
      <main className="single">
        <section className="panel">
          <div className="leads-filters">
            <input placeholder="Search name, company, email, domain, title…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="inline"><input type="checkbox" checked={hasEmail} onChange={(e) => resetPage(setHasEmail)(e.target.checked)} /> Has email</label>
            <label className="inline"><input type="checkbox" checked={hasPhone} onChange={(e) => resetPage(setHasPhone)(e.target.checked)} /> Has phone</label>
            <input className="narrow" placeholder="Country (US)" value={country} onChange={(e) => resetPage(setCountry)(e.target.value.toUpperCase().slice(0, 2))} />
            <select value={job} onChange={(e) => resetPage(setJob)(e.target.value)}>
              <option value="">All jobs and runs</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            {data?.backgroundExports ? (
              <>
                <button type="button" className="secondary small" disabled={exp?.status === "queued" || exp?.status === "running"} onClick={() => void backgroundExport("csv")}>⬇ CSV</button>
                <button type="button" className="secondary small" disabled={exp?.status === "queued" || exp?.status === "running"} onClick={() => void backgroundExport("xlsx")}>⬇ Excel</button>
              </>
            ) : (
              <>
                <a className="btn secondary small" href={`/api/leads/export?${params}&fmt=csv`}>⬇ CSV</a>
                <a className="btn secondary small" href={`/api/leads/export?${params}&fmt=xlsx`}>⬇ Excel</a>
              </>
            )}
          </div>
          <p className="hint">Downloads include every lead that matches these filters, not just this page.</p>
          {exp && (
            <div className={exp.status === "failed" ? "error" : "ok-line"}>
              {exp.status === "queued" || exp.status === "running" ? "⏳ Preparing your file in the background…"
                : exp.status === "done" ? <>✓ Ready: {Number(exp.rows ?? 0).toLocaleString()} rows. <a href={exp.url ?? "#"}>⬇ Download</a> (link valid for 1 hour)</>
                : `Export failed: ${exp.error}`}
            </div>
          )}
          <div className="table-wrap tall">
            <table>
              <thead><tr>{cols.map((c) => <th key={c}>{humanize(c)}</th>)}</tr></thead>
              <tbody>
                {!data ? (
                  <tr className="empty"><td>Loading…</td></tr>
                ) : data.rows.length === 0 ? (
                  <tr className="empty"><td>No leads match.</td></tr>
                ) : data.rows.map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => {
                      const v = r[c];
                      if (v === undefined || v === "") {
                        const status = c === "email" ? r.email_status : c === "phone" ? r.phone_status : "";
                        return <td key={c}><span className="none">{String(status || "").replace(/_/g, " ")}</span></td>;
                      }
                      if (/_url$/.test(c)) return <td key={c}><a href={String(v)} target="_blank" rel="noopener">link</a></td>;
                      if (c === "saved_at") return <td key={c}>{String(v).slice(0, 10)}</td>;
                      return <td key={c} title={String(v)} className={c === "failed_step" ? "error" : undefined}>{String(v).slice(0, 60)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" className="secondary small" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>← Prev</button>
            <span className="muted">Page {page.toLocaleString()}{pages ? ` of ${pages.toLocaleString()}` : ""}</span>
            <button type="button" className="secondary small" disabled={!data?.hasMore || loading} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        </section>
      </main>
    </>
  );
}
