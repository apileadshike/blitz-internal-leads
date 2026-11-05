"use client";
// Every saved lead, paged and filterable, read straight from the database.
import { useEffect, useMemo, useState } from "react";
import { Header } from "./header";
import { humanize } from "./schema-form";
import { IconDownload, IconSearch } from "./icons";

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

  // Name + title and company + domain are shown together; the other columns follow.
  const extra = cols.filter((c) => !["full_name", "job_title", "company_name", "company_domain", "email", "phone", "person_linkedin_url", "company_linkedin_url", "saved_at"].includes(c));
  const busyExport = exp?.status === "queued" || exp?.status === "running";

  return (
    <>
      <Header active="leads" right={<div className="stat-chips"><span className="stat-chip">{data ? <><b>{data.total.toLocaleString()}{data.exact ? "" : "+"}</b> leads match</> : "Loading…"}</span></div>} />
      <main className="single">
        <div className="page-head">
          <div>
            <h2>Leads</h2>
            <p>Every lead saved by your runs and jobs. Downloads include all matching leads, not just this page.</p>
          </div>
          <div className="toolbar">
            {data?.backgroundExports ? (
              <>
                <button type="button" className="secondary" disabled={busyExport} onClick={() => void backgroundExport("csv")}><IconDownload /> CSV</button>
                <button type="button" disabled={busyExport} onClick={() => void backgroundExport("xlsx")}><IconDownload /> Excel</button>
              </>
            ) : (
              <>
                <a className="btn secondary" href={`/api/leads/export?${params}&fmt=csv`}><IconDownload /> CSV</a>
                <a className="btn" href={`/api/leads/export?${params}&fmt=xlsx`}><IconDownload /> Excel</a>
              </>
            )}
          </div>
        </div>

        <section className="panel">
          <div className="leads-filters">
            <div className="search">
              <IconSearch />
              <input placeholder="Search name, company, email, domain, title…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" className={"toggle" + (hasEmail ? " on" : "")} onClick={() => resetPage(setHasEmail)(!hasEmail)}>Has email</button>
            <button type="button" className={"toggle" + (hasPhone ? " on" : "")} onClick={() => resetPage(setHasPhone)(!hasPhone)}>Has phone</button>
            <input className="narrow" placeholder="Country (US)" value={country} onChange={(e) => resetPage(setCountry)(e.target.value.toUpperCase().slice(0, 2))} />
            <select value={job} onChange={(e) => resetPage(setJob)(e.target.value)}>
              <option value="">All jobs and runs</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </div>
          {exp && (
            <div className={exp.status === "failed" ? "error" : "ok-line"}>
              {busyExport ? "Preparing your file in the background…"
                : exp.status === "done" ? <>Ready: {Number(exp.rows ?? 0).toLocaleString()} rows. <a href={exp.url ?? "#"}>Download</a> (link valid for 1 hour)</>
                : `Export failed: ${exp.error}`}
            </div>
          )}
          <div className={"table-wrap tall" + (loading ? " loading" : "")}>
            <table className="leads">
              <thead><tr>
                <th>Lead</th><th>Company</th><th>Email</th><th>Phone</th>
                {extra.map((c) => <th key={c}>{humanize(c)}</th>)}
                <th>LinkedIn</th><th>Saved</th>
              </tr></thead>
              <tbody>
                {!data ? (
                  <tr className="empty"><td colSpan={7}>Loading…</td></tr>
                ) : data.rows.length === 0 ? (
                  <tr className="empty"><td colSpan={7}>No leads match these filters.</td></tr>
                ) : data.rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <div className="lead">
                        <span className="avatar">{initials(r.full_name ?? r.company_name)}</span>
                        <div><b>{r.full_name ?? <span className="none">no name</span>}</b><small title={r.job_title}>{String(r.job_title ?? "").slice(0, 48)}</small></div>
                      </div>
                    </td>
                    <td><div className="stack"><span>{r.company_name ?? ""}</span><small>{r.company_domain ?? ""}</small></div></td>
                    <td>{r.email ? <span className="contact">{r.email}</span> : <span className="none">{String(r.email_status ?? "").replace(/_/g, " ")}</span>}</td>
                    <td>{r.phone ? <span className="contact">{r.phone}</span> : <span className="none">{String(r.phone_status ?? "").replace(/_/g, " ")}</span>}</td>
                    {extra.map((c) => (
                      <td key={c} title={String(r[c] ?? "")} className={c === "failed_step" ? "error" : undefined}>{r[c] === undefined || r[c] === "" ? "" : String(r[c]).slice(0, 40)}</td>
                    ))}
                    <td className="links">
                      {r.person_linkedin_url && <a href={String(r.person_linkedin_url)} target="_blank" rel="noopener">Person</a>}
                      {r.company_linkedin_url && <a href={String(r.company_linkedin_url)} target="_blank" rel="noopener">Company</a>}
                    </td>
                    <td className="soft">{String(r.saved_at ?? "").slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="muted">Page {page.toLocaleString()}{pages ? ` of ${pages.toLocaleString()}` : ""}</span>
            <button type="button" className="secondary small" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button>
            <button type="button" className="secondary small" disabled={!data?.hasMore || loading} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </section>
      </main>
    </>
  );
}

function initials(name?: string) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
