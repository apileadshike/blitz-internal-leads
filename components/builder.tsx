"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconChevron, IconDownload, IconPlay, IconRefresh, IconStop, IconUp, IconX } from "./icons";
import { Header } from "./header";
import { dialog } from "./dialog";
import { PRESETS, type Pipeline } from "./presets";
import { StepForm, cleanParams, humanize } from "./schema-form";
import { DEFAULT_CHAIN, ImportPanel, baseName, buildImport, companyPair, estimateRecords, sourceFor, type ImportResult, type ImportState } from "./import-panel";
import type { IdType } from "@/lib/idtypes";
import { readImportFile } from "@/lib/import";
import { uploadList } from "./import-upload";

type Entity = "company" | "person" | "job";
type CatalogStep = {
  id: string; label: string; endpoint: string; group: "source" | "expand" | "enrich" | "filter" | "send"; help: string;
  needs: Entity | null; gives: Entity[]; dedupe_on: Entity | null; docs: string | null;
  schema: { type: "object"; properties: Record<string, any> };
};
type BuilderStep = { uid: number; id: string; params: Record<string, any> };
type StageStats = {
  id: string; label: string; group: string; dedupe_on: Entity | null; status: string;
  received: number; waiting: number; in_flight: number; done: number; out: number; duplicates: number;
  hits: number; errors: number; records: number; skipped: number; filtered: number; cached?: number;
};
type RunStats = {
  stages: StageStats[]; saved: number; records_used: number; max_records: number; failed?: number;
  status?: string; elapsed?: number; max_items?: number; source_count?: number; source_done?: boolean;
};

/** 45s, 3m 12s, 1h 4m */
function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
type LogEv = { at: number; stage: string; message: string };
type Row = Record<string, any>;

const ADD_GROUPS: [string, string][] = [
  ["expand", "Find people / jobs for each company"],
  ["enrich", "Add data to each row"],
  ["filter", "Filter / tag rows (free)"],
  ["send", "Send rows somewhere"],
];
const PREFERRED = ["full_name", "job_title", "email", "phone", "company_name", "company_domain", "country", "icp_tier",
  "committee_role", "icp_fit", "icp_fit_reasons", "job_change", "previous_company_name", "new_since_last_run",
  "company_industry", "company_size", "company_hq_country", "job_posting_title", "matched_jobs", "matched_people",
  "top_countries", "top_departments", "company_email_domain", "failed_step", "person_linkedin_url", "company_linkedin_url"];

let uidSeq = 0;
const nextUid = () => ++uidSeq;
const loadSaved = (): Record<string, Pipeline> => JSON.parse(localStorage.getItem("pipelines") || "{}");

export function Builder() {
  const [catalog, setCatalog] = useState<CatalogStep[]>([]);
  const byId = useMemo(() => Object.fromEntries(catalog.map((s) => [s.id, s])), [catalog]);
  const [account, setAccount] = useState<{ error?: string; plan?: string; left?: number; rps?: number; people?: number; companies?: number } | null>(null);
  /** Steps whose settings are folded away (by uid). */
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const toggleFold = (uid: number) => setFolded((f) => { const n = new Set(f); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });

  // builder state
  const [steps, setSteps] = useState<BuilderStep[]>([]);
  const [maxItems, setMaxItems] = useState(20);
  const [all, setAll] = useState(false);
  const [concurrency, setConcurrency] = useState(20);
  const [maxRecords, setMaxRecords] = useState(500);
  const [skipSeenPeople, setSkipSeenPeople] = useState(true);
  const [skipSeenCompanies, setSkipSeenCompanies] = useState(false);
  const [useCache, setUseCache] = useState(true);
  const [preset, setPreset] = useState("");
  const [saved, setSaved] = useState<Record<string, Pipeline>>({});
  const [addValue, setAddValue] = useState("");
  const [formError, setFormError] = useState("");

  // import + jobs
  const [imp, setImp] = useState<ImportState | null>(null);
  const [importing, setImporting] = useState(false);
  const [jobName, setJobName] = useState("");
  const [repeatHours, setRepeatHours] = useState("");
  const [jobMsg, setJobMsg] = useState<React.ReactNode>(null);
  const [creating, setCreating] = useState(false);
  const [sideMsg, setSideMsg] = useState<React.ReactNode>(null);
  /** An imported list being sent to the server: buttons that need it wait until it's done. */
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const uploadSeq = useRef(0);
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // live run
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [logs, setLogs] = useState<LogEv[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [newestCount, setNewestCount] = useState(0);
  const [tab, setTab] = useState<"results" | "activity">("results");
  // Big runs: the file is built in the background (by the worker, stored in R2) instead of streamed,
  // because a streamed download is cut off after 5 minutes on Vercel.
  const [exp, setExp] = useState<{ status: string; rows?: number | null; url?: string | null; error?: string | null } | null>(null);
  async function downloadRun(fmt: "csv" | "xlsx") {
    if (!runId) return;
    setExp({ status: "queued" });
    const r = await fetch(`/api/exports?run=${encodeURIComponent(runId)}&fmt=${fmt}&name=leads-${runId}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setExp({ status: "failed", error: j.error ?? `HTTP ${r.status}` });
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      const st = await (await fetch(`/api/exports/${j.id}`)).json().catch(() => null);
      if (!st) continue;
      setExp(st);
      if (st.status === "done") { window.location.href = st.url; break; }
      if (st.status === "failed") break;
    }
  }
  const samples = useRef<{ t: number; work: number; saved: number }[]>([]);

  function loadPipeline(p: Pipeline, cat = byId) {
    setSteps(p.steps.filter((s) => cat[s.step]).map((s) => ({ uid: nextUid(), id: s.step, params: structuredClone(s.params ?? {}) })));
    setAll(p.maxItems === 0);
    if (p.maxItems) setMaxItems(p.maxItems);
    if (p.concurrency) setConcurrency(p.concurrency);
    if (p.maxRecords) setMaxRecords(p.maxRecords);
    if (p.skipSeenPeople !== undefined) setSkipSeenPeople(p.skipSeenPeople);
    if (p.skipSeenCompanies !== undefined) setSkipSeenCompanies(p.skipSeenCompanies);
    if (p.useCache !== undefined) setUseCache(p.useCache);
  }

  // Boot: step catalog + account info, default recipe, and "Watch" links from the Jobs page.
  useEffect(() => {
    setSaved(loadSaved());
    Promise.all([fetch("/api/steps").then((r) => r.json()), fetch("/api/meta").then((r) => r.json())]).then(([cat, meta]: [CatalogStep[], any]) => {
      setCatalog(cat);
      const a = meta.account;
      setAccount(a?.error
        ? { error: a.error }
        : { plan: a.active_plans?.[0]?.name ?? "plan", left: Number(a.records_remaining), rps: a.max_requests_per_seconds, people: meta.db.people, companies: meta.db.companies });
      const first = Object.keys(PRESETS)[0];
      loadPipeline(PRESETS[first], Object.fromEntries(cat.map((s) => [s.id, s])));
      setPreset("p:" + first); // the default recipe is loaded, so show its name
      const m = location.hash.match(/run=([\w-]+)/);
      if (m) watch(m[1]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── builder helpers ──
  const entitiesBefore = (index: number) => {
    const have = new Set<Entity>();
    steps.slice(0, index).forEach((s) => byId[s.id]?.gives.forEach((g) => have.add(g)));
    return have;
  };
  const haveAll = entitiesBefore(steps.length);
  const addOptions = catalog.filter((c) => c.group !== "source");
  const firstAddable = addOptions.find((c) => !c.needs || haveAll.has(c.needs))?.id ?? "";
  const addSelected = addOptions.some((c) => c.id === addValue && (!c.needs || haveAll.has(c.needs))) ? addValue : firstAddable;

  const updateStep = (i: number, patch: Partial<BuilderStep>) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number) => setSteps((all) => { const n = [...all]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; });
  const remove = (i: number) => setSteps((all) => all.filter((_, j) => j !== i));
  const add = () => { if (addSelected) setSteps((all) => [...all, { uid: nextUid(), id: addSelected, params: {} }]); };

  const currentPipeline = (): Required<Pipeline> => ({
    steps: steps.map((s) => ({ step: s.id, params: cleanParams(s.params) ?? {} })),
    maxItems: all ? 0 : Number(maxItems),
    concurrency: Number(concurrency),
    maxRecords: Number(maxRecords),
    skipSeenPeople,
    skipSeenCompanies,
    useCache,
  });

  // ── recipes + saved pipelines (stored in this browser) ──
  const onPreset = (v: string) => {
    setPreset(v);
    if (!v) return;
    const name = v.slice(2);
    const p = v.startsWith("p:") ? PRESETS[name] : saved[name];
    if (p) loadPipeline(p);
  };
  const savePipeline = async () => {
    const name = await dialog.prompt({
      title: "Save pipeline",
      message: "Saved in this browser. Load it again from the recipe list under \"My saved pipelines\".",
      placeholder: "e.g. SaaS founders US",
      defaultValue: preset.startsWith("s:") ? preset.slice(2) : "",
      confirmLabel: "Save",
    });
    if (!name) return;
    if (loadSaved()[name] && !(await dialog.confirm({
      title: `Replace "${name}"?`, message: "A saved pipeline with this name already exists. Saving replaces it.", confirmLabel: "Replace",
    }))) return;
    const next = { ...loadSaved(), [name]: currentPipeline() };
    localStorage.setItem("pipelines", JSON.stringify(next));
    setSaved(next);
    setPreset("s:" + name); // show the pipeline just saved
  };

  // ── run ──
  // Button feedback: shown the moment a button is clicked, and it can't be clicked twice
  // (a second click on Run now would start a second run).
  const [pending, setPending] = useState<"start" | "stop" | "rerun" | null>(null);
  const start = async (override?: Partial<Pipeline>) => {
    if (pending) return;
    setFormError("");
    setPending("start");
    try {
      const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...currentPipeline(), ...override }) });
      const j = await r.json();
      if (!r.ok) return setFormError(j.error);
      watch(j.id);
    } catch (e) {
      setFormError(`Couldn't start the run: ${(e as Error).message}`);
    } finally {
      setPending(null);
    }
  };

  // ── Cost preview + "Test 10 rows" ──
  const [preview, setPreview] = useState<React.ReactNode>(null);
  const [previewing, setPreviewing] = useState(false);
  const listCount = () => String(steps[0]?.params?.list ?? "").split(/[\r\n,;]+/).filter((x) => x.trim()).length;
  const isList = () => !!steps[0] && /^list_/.test(steps[0].id);
  const estimateCost = async () => {
    setFormError(""); setPreview(null);
    if (!steps.length) return;
    // A pasted/imported list: count it, no API call.
    if (isList()) {
      const typed = listCount();
      const up = Number(steps[0].params?.upload_count ?? 0);
      const n = typed + up;
      // In a company list, LinkedIn URLs are free: only the domains cost a lookup.
      const linkedin = String(steps[0].params?.list ?? "").split(/[\r\n,;]+/).filter((x) => /linkedin\.com\//i.test(x)).length;
      const paid = (steps[0].id === "list_domains" ? typed - linkedin : typed) + Number(steps[0].params?.upload_paid ?? up);
      const est = estimateRecords(steps, byId, n, paid);
      setPreview(<>{n.toLocaleString()} rows in the list, up to <b>{est.toLocaleString()}</b> records for everything (lookups that find nothing are free, so usually less).</>);
      return;
    }
    if (!/^POST /.test(byId[steps[0].id]?.endpoint ?? "")) {
      setPreview(<>Step 1 reads your own database: no search cost. Later steps cost up to {estimateRecords(steps, byId, 1)} record(s) per row.</>);
      return;
    }
    setPreviewing(true);
    try {
      const r = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: currentPipeline().steps }) });
      const j = await r.json();
      if (!r.ok) return setFormError(`Estimate failed: ${j.error}`);
      const n = all ? j.usable : Math.min(j.usable, Number(maxItems));
      const est = estimateRecords(steps, byId, n);
      setPreview(<>Blitz has <b>{Number(j.total).toLocaleString()}</b> matches{j.total > 50_000 ? " (one search returns at most 50,000; split it with a job split)" : ""}.
        {" "}For {all ? "all results" : `your max of ${Number(maxItems).toLocaleString()}`} ({n.toLocaleString()} rows): up to <b>{est.toLocaleString()}</b> records.
        {" "}<span className="muted">(This check used {j.records_used} record.)</span></>);
    } finally {
      setPreviewing(false);
    }
  };
  /** Run the pipeline on its first 10 rows only, to check the results before a big job. */
  const testTen = () => {
    const est = Math.max(10, estimateRecords(steps, byId, 10));
    void start({ maxItems: 10, maxRecords: Math.min(est, Number(maxRecords) || est) });
  };
  /** Stop at once in the page; the live view confirms within a second. "Stopping…" stays until it does. */
  const stop = async () => {
    if (!runId || pending) return;
    setPending("stop");
    try {
      const r = await fetch(`/api/runs/${runId}/stop`, { method: "POST" });
      if (!r.ok) { setPending(null); setFormError("Couldn't stop the run. Try again."); }
    } catch {
      setPending(null);
      setFormError("Couldn't stop the run. Try again.");
    }
  };
  /** Put the leads whose step failed back into the queue at that step, and watch again. */
  const rerunFailed = async () => {
    if (!runId || pending) return;
    setPending("rerun");
    try {
      const r = await fetch(`/api/runs/${runId}/rerun-failed`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) return setFormError(j.error);
      watch(runId);
    } finally {
      setPending(null);
    }
  };

  // ── Create job: one click, everything comes from the form ──
  const createJob = async () => {
    setFormError(""); setJobMsg(null);
    const p = currentPipeline();
    const name = jobName.trim() || (preset ? preset.slice(2) : "") || `Job ${new Date().toLocaleString()}`;
    setCreating(true);
    try {
      const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        name, steps: p.steps, record_budget: p.maxRecords, workers: p.concurrency,
        skip_seen_people: p.skipSeenPeople, skip_seen_companies: p.skipSeenCompanies, use_cache: p.useCache,
        max_results: p.maxItems, // 0 = All results
        repeat_every_hours: Number(repeatHours) > 0 ? Number(repeatHours) : undefined,
      }) });
      const j = await r.json();
      if (!r.ok) return setFormError(j.error);
      setJobMsg(<>Job <b>{name}</b> created. It runs in the background until done. <a href="/jobs">Open Jobs</a></>);
    } finally {
      setCreating(false);
    }
  };

  // ── Import a file ──
  /** Does `rest` work after source `src`? (each step's input exists by then) */
  const chainFits = (src: string, rest: string[]) => {
    const have = new Set(byId[src]?.gives ?? []);
    for (const id of rest) {
      const d = byId[id];
      if (!d || d.group === "source" || (d.needs && !have.has(d.needs))) return false;
      d.gives.forEach((g) => have.add(g));
    }
    return true;
  };

  function applyImport(st: ImportState, current = steps) {
    setImp(st);
    const { values, inputRows, paidFirst } = buildImport(st);
    const src = sourceFor(st);
    const rest = current.slice(1);
    const tail = rest.length && chainFits(src, rest.map((s) => s.id))
      ? rest
      : DEFAULT_CHAIN[st.type].map((s) => ({ uid: nextUid(), id: s.step, params: structuredClone(s.params) }));
    const uid = nextUid();
    const info = { upload_name: st.result.file, upload_count: values.length, upload_paid: paidFirst };
    const next = [{ uid, id: src, params: { list: "", ...info, upload_pending: true } }, ...tail];
    setSteps(next);
    setAll(true); // every row of the file
    const est = estimateRecords(next, byId, values.length, paidFirst);
    if (est > 0) setMaxRecords(est);
    setPreset("");
    // Send the list to the server (in chunks), a moment after the last change in the import panel.
    const seq = ++uploadSeq.current;
    if (uploadTimer.current) clearTimeout(uploadTimer.current);
    setUploading({ done: 0, total: values.length });
    uploadTimer.current = setTimeout(async () => {
      try {
        const id = await uploadList(st.result.file, values, inputRows, (done, total) => { if (seq === uploadSeq.current) setUploading({ done, total }); });
        if (seq !== uploadSeq.current) return; // a newer import replaced this one
        setSteps((all) => all.map((x) => (x.uid === uid ? { ...x, params: { ...x.params, upload_id: id, upload_pending: undefined } } : x)));
        setUploading(null);
      } catch (e) {
        if (seq !== uploadSeq.current) return;
        setUploading(null);
        setFormError(`Upload failed: ${(e as Error).message}`);
      }
    }, 500);
  }

  /** The other kind of lead in the same file (people vs companies) as its own job, with the usual steps. */
  async function createSideJob(column: number, type: IdType) {
    if (!imp) return;
    const st: ImportState = { ...imp, column, type, combine: !!companyPair(imp.result) };
    const { values, inputRows, paidFirst } = buildImport(st);
    setSideMsg(<>Uploading {values.length.toLocaleString()} rows…</>);
    let uploadId: string;
    try { uploadId = await uploadList(imp.result.file, values, inputRows); } catch (e) { setSideMsg(null); return setFormError(`Upload failed: ${(e as Error).message}`); }
    const jobSteps = [
      { step: sourceFor(st), params: { list: "", upload_id: uploadId, upload_name: imp.result.file, upload_count: values.length, upload_paid: paidFirst } },
      ...DEFAULT_CHAIN[type],
    ];
    const est = estimateRecords(jobSteps.map((s) => ({ id: s.step, params: s.params })), byId, values.length, paidFirst);
    const kind = type === "person_url" || type === "email" || type === "phone" ? "people" : "companies";
    const name = `${jobName || baseName(imp.result.file)} (${kind})`;
    const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name, steps: jobSteps, record_budget: Math.max(est, 1), workers: Number(concurrency),
      skip_seen_people: skipSeenPeople, skip_seen_companies: skipSeenCompanies, use_cache: useCache,
    }) });
    const j = await r.json();
    if (!r.ok) return setFormError(j.error);
    setSideMsg(<>Job <b>{name}</b> created ({values.length.toLocaleString()} rows, up to {est.toLocaleString()} records). <a href="/jobs">Open Jobs</a></>);
  }

  async function onFile(f: File) {
    setFormError(""); setJobMsg(null);
    setImporting(true);
    try {
      // A saved pipeline or job file: load it into the builder.
      if (/\.json$/i.test(f.name)) {
        const p = JSON.parse(await f.text());
        if (!Array.isArray(p.steps)) throw new Error("This JSON file has no \"steps\" list.");
        loadPipeline({
          steps: p.steps, maxItems: p.maxItems ?? 0, concurrency: p.concurrency ?? p.workers,
          maxRecords: p.maxRecords ?? p.record_budget, skipSeenPeople: p.skipSeenPeople ?? p.skip_seen_people,
          skipSeenCompanies: p.skipSeenCompanies ?? p.skip_seen_companies,
        });
        setJobName(p.name ?? baseName(f.name));
        if (p.repeat_every_hours) setRepeatHours(String(p.repeat_every_hours));
        setImp(null); setPreset("");
        return;
      }
      // A list (CSV / Excel): detect the column, fill step 1.
      // Read in the browser: big files never go through the server in one piece.
      const res: ImportResult = await readImportFile(f);
      if (!res.rows.length) throw new Error("No rows found in the file.");
      const first = res.suggestion ?? { column: 0, type: "domain" as const };
      if (!res.suggestion) setFormError("Couldn't tell what the file holds: pick the column and what it contains below.");
      setJobName(baseName(f.name));
      // A file with both LinkedIn company URLs and domains: LinkedIn first (free), domain as fallback.
      const pair = companyPair(res);
      const begin = pair && (first.type === "domain" || first.type === "company_url") ? { column: pair.li, type: "company_url" as const } : first;
      setSideMsg(null);
      applyImport({ result: res, column: begin.column, type: begin.type, keep: true, combine: !!pair });
    } catch (e) {
      setFormError(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // ── live view (Server-Sent Events) ──
  const source = useRef<EventSource | null>(null);
  const rowBuffer = useRef<Row[]>([]);
  /**
   * Follow a run live. The server closes each connection after ~40 s (hosting time
   * limits); we reconnect from the last log/row we have, so nothing repeats or is missed.
   */
  const watchSeq = useRef(0);
  function watch(id: string) {
    source.current?.close();
    const seq = ++watchSeq.current; // a newer watch() cancels this one
    setRunId(id); setRunning(true); setStats(null); setLogs([]); setRows([]); setNewestCount(0); setExp(null);
    rowBuffer.current = [];
    const cursor = { log: 0, row: 0 };
    let failures = 0;
    const connect = () => {
      if (seq !== watchSeq.current) return;
      const es = new EventSource(`/api/runs/${id}/events?log=${cursor.log}&row=${cursor.row}`);
      source.current = es;
      let done = false;
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data);
        failures = 0;
        if (ev.type === "stats") setStats(ev.stats);
        else if (ev.type === "log") setLogs((l) => [ev, ...l]);
        else if (ev.type === "row") rowBuffer.current.push(ev.row);
        else if (ev.type === "cursor") { cursor.log = ev.log; cursor.row = ev.row; }
        else if (ev.type === "reconnect") { done = true; es.close(); setTimeout(connect, 300); }
        else if (ev.type === "finished") { done = true; es.close(); setRunning(false); setPending((p) => (p === "stop" ? null : p)); }
      };
      es.onerror = () => {
        if (done) return;
        es.close(); // reconnect ourselves, from the saved position
        if (++failures > 20) { setRunning(false); return; }
        setTimeout(connect, Math.min(10_000, 1000 * failures));
      };
    };
    connect();
  }
  // Rows can arrive hundreds per second: add them to the table in small bursts.
  useEffect(() => {
    const t = setInterval(() => {
      if (!rowBuffer.current.length) return;
      const batch = rowBuffer.current;
      rowBuffer.current = [];
      setNewestCount(batch.length);
      setRows((r) => [...r, ...batch]);
    }, 250);
    return () => { clearInterval(t); source.current?.close(); };
  }, []);

  const columns = useMemo(() => {
    const known = PREFERRED.filter((c) => rows.some((r) => r[c] !== undefined)).slice(0, 12);
    const fromFile = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r).filter((k) => k.startsWith("in_"))))].slice(0, 4);
    return [...fromFile, ...known];
  }, [rows]);
  const shown = useMemo(() => rows.slice(-500).reverse(), [rows]);

  const budgetPct = stats && stats.max_records ? Math.min(100, (stats.records_used / stats.max_records) * 100) : 0;

  // ── speed and ETA, from the last ~15 seconds of live stats ──
  const speed = useMemo(() => {
    if (!stats) { samples.current = []; return null; }
    const after = stats.stages.length - 1;
    // Work done so far: lookups in the steps after step 1 (or results found, for a search on its own).
    const work = after > 0
      ? stats.stages.slice(1).reduce((a, x) => a + x.done, 0)
      : stats.stages[0].out + stats.stages[0].duplicates;
    const now = Date.now();
    samples.current = [...samples.current.filter((x) => now - x.t < 15_000), { t: now, work, saved: stats.saved }];
    const first = samples.current[0];
    const secs = (now - first.t) / 1000;
    if (secs < 2) return null;
    const perSec = (work - first.work) / secs;
    const leadsPerMin = ((stats.saved - first.saved) / secs) * 60;
    // What's left: rows waiting in the steps, plus results not fetched yet (when the run has a limit).
    const queued = stats.stages.slice(1).reduce((a, x) => a + x.waiting + x.in_flight, 0);
    const toFetch = stats.source_done ? 0 : stats.max_items ? Math.max(0, stats.max_items - (stats.source_count ?? 0)) : null;
    const left = toFetch === null ? null : (after > 0 ? queued + toFetch * after : toFetch);
    const eta = left !== null && perSec > 0 ? left / perSec : null;
    return { perSec, leadsPerMin, eta };
  }, [stats]);
  const finished = !!stats && !running && !!stats.status && !["running", "draining"].includes(stats.status);
  const found = (id: string) => {
    const st = stats?.stages.find((x) => x.id === id);
    return st && st.done ? { hits: st.hits, pct: Math.round((100 * st.hits) / st.done) } : null;
  };
  const fmt = (n?: number) => (n ?? 0).toLocaleString();

  return (
    <>
      <Header active="builder" right={
        <div className="stat-chips">
          {!account ? <span className="stat-chip">Loading account…</span>
            : account.error ? <span className="stat-chip err">API key problem: {account.error}</span>
            : <>
                <span className="stat-chip"><span className="live" />{account.plan}</span>
                <span className="stat-chip"><b>{fmt(account.left)}</b> records left</span>
                <span className="stat-chip"><b>{account.rps}</b> req/s</span>
                <span className="stat-chip"><b>{fmt(account.people)}</b> people · <b>{fmt(account.companies)}</b> companies</span>
              </>}
        </div>
      } />
      <main className="workspace">
        <div className="col-left">
        <div className="page-head">
          <div>
            <h2>Pipeline builder</h2>
            <p>Find leads, enrich them step by step, and save them. Every step runs at the same time.</p>
          </div>
          <div className="toolbar">
            <select value={preset} onChange={(e) => onPreset(e.target.value)} title="Start from a ready-made recipe or one you saved">
              <option value="">Load a recipe…</option>
              <optgroup label="Recipes">
                {Object.keys(PRESETS).map((k) => <option key={k} value={"p:" + k}>{k}</option>)}
              </optgroup>
              {Object.keys(saved).length > 0 && (
                <optgroup label="My saved pipelines">
                  {Object.keys(saved).map((k) => <option key={k} value={"s:" + k}>{k}</option>)}
                </optgroup>
              )}
            </select>
            <button type="button" className="secondary" onClick={() => void savePipeline()} title="Save this pipeline in your browser">Save</button>
            <button type="button" className="secondary" disabled={importing} onClick={() => fileInput.current?.click()}
              title="CSV or Excel list of domains, LinkedIn URLs, emails or phones, or a saved pipeline/job (.json)">
              {importing ? "Reading…" : "Import file"}
            </button>
            <input ref={fileInput} type="file" hidden accept=".csv,.tsv,.txt,.xlsx,.json"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          </div>
        </div>

        {/* ───────── Builder ───────── */}
        <section className="panel builder">
          <div className="panel-h">
            <div>
              <h2>Steps <span className="count">{steps.length}</span></h2>
              <div className="sub">Step 1 finds data (or import a file). Each next step works on what the steps before it found.</div>
            </div>
          </div>
          {imp && (
            <ImportPanel state={imp} onChange={(st) => applyImport(st)} onClose={() => setImp(null)}
              onSideJob={(c, t) => void createSideJob(c, t)} sideJobMsg={sideMsg}
              estimate={steps.length ? (() => { const x = buildImport(imp); return estimateRecords(steps, byId, x.values.length, x.paidFirst); })() : null} />
          )}

          <div className="steps">
            {steps.map((s, i) => {
              const def = byId[s.id];
              if (!def) return null;
              const have = entitiesBefore(i);
              const invalid = i === 0 ? def.group !== "source" : def.group === "source" || (!!def.needs && !have.has(def.needs));
              const hasFields = Object.keys(def.schema.properties).length > 0;
              const open = !folded.has(s.uid);
              return (
                <div key={s.uid}>
                  <div className={"step" + (invalid ? " invalid" : "")}>
                    <div className="step-h">
                      <span className="num">{i + 1}</span>
                      {i === 0 ? (
                        // Step 1: choose any source
                        <select value={s.id} onChange={(e) => updateStep(0, { id: e.target.value, params: {}, uid: nextUid() })}>
                          {catalog.filter((c) => c.group === "source").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      ) : <b>{def.label}</b>}
                      <span className={"group-tag " + def.group}>{def.group}</span>
                      <span className="ctrls">
                        {hasFields && (
                          <button type="button" className="link" title={open ? "Hide settings" : "Show settings"} onClick={() => toggleFold(s.uid)}>
                            <IconChevron className={"chev" + (open ? " open" : "")} />
                          </button>
                        )}
                        {i > 0 && <>
                          <button type="button" className="link" title="Move up" disabled={i === 1} onClick={() => move(i)}><IconUp /></button>
                          <button type="button" className="link" title="Remove" onClick={() => remove(i)}><IconX /></button>
                        </>}
                      </span>
                    </div>
                    <div className="step-meta">
                      <code>{def.endpoint}</code> · {def.help}
                      {def.docs && <> <a href={def.docs} target="_blank">Setup guide</a></>}
                    </div>
                    {invalid && <div className="error">{def.group === "source" ? "Sources can only be step 1" : `Needs ${def.needs} data. Add a step that provides it first.`}</div>}
                    {i === 0 && s.params.upload_name && (
                      <div className="upload-note">
                        {String(s.params.upload_name)}: {Number(s.params.upload_count ?? 0).toLocaleString()} rows
                        {s.params.upload_id ? " uploaded" : uploading ? ` uploading… ${uploading.done.toLocaleString()} / ${uploading.total.toLocaleString()}` : " (not uploaded)"}
                        {" "}(plus anything typed below){" "}
                        <button type="button" className="link" onClick={() => updateStep(0, { params: { ...s.params, upload_id: undefined, upload_name: undefined, upload_count: undefined, upload_paid: undefined, upload_pending: undefined } })}>remove file</button>
                      </div>
                    )}
                    {hasFields && open && (
                      <div className="step-body">
                        <StepForm schema={def.schema} value={s.params} onChange={(params) => updateStep(i, { params })} />
                      </div>
                    )}
                  </div>
                  {def.dedupe_on && (
                    <div className="dedupe">Duplicate check on <b>{def.dedupe_on}</b>: skips repeats in this run{def.dedupe_on === "job" ? "" : ", and earlier runs if switched on below"}</div>
                  )}
                  <div className="down" />
                </div>
              );
            })}
            <div className="add-step">
              <select value={addSelected} onChange={(e) => setAddValue(e.target.value)}>
                {ADD_GROUPS.map(([g, label]) => (
                  <optgroup key={g} label={label}>
                    {addOptions.filter((c) => c.group === g).map((c) => {
                      const ok = !c.needs || haveAll.has(c.needs);
                      return <option key={c.id} value={c.id} disabled={!ok}>{c.label}{ok ? "" : ` (needs ${c.needs})`}</option>;
                    })}
                  </optgroup>
                ))}
              </select>
              <button type="button" className="secondary" onClick={add}>+ Add step</button>
            </div>
            {steps.length > 0 && (
              <>
                <div className="down" />
                <div className="step save">
                  <div className="step-h"><span className="num"><IconCheck /></span><b>Save</b></div>
                  <div className="step-meta">Saved to your database, with a CSV / Excel download.</div>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <div className="card-h">Run settings</div>
            <div className="grid3">
              <label title="How many results to take from step 1 (the search or your list)."><span className="lbl">Max results</span>
                <input type="number" min={1} value={maxItems} disabled={all} onChange={(e) => setMaxItems(Number(e.target.value))} />
                <span className="all-toggle"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All results</span>
              </label>
              <label title="How many lookups each step makes at the same time (1–50). Speed only: the cost is the same."><span className="lbl">Workers per step</span>
                <input type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
              </label>
              <label title="The run stops before spending more than this many records."><span className="lbl">Record budget</span>
                <input type="number" min={1} value={maxRecords} onChange={(e) => setMaxRecords(Number(e.target.value))} />
              </label>
            </div>
            {all && <p className="hint">All results: keeps going until the search has no more results (Blitz stops at 50,000 per search). The record budget still applies, so raise it for big pulls.</p>}
            <div style={{ marginTop: 10 }}>
              <label className="switch"><input type="checkbox" checked={skipSeenPeople} onChange={(e) => setSkipSeenPeople(e.target.checked)} />
                <span>Skip people already in my database<small>Only new people are enriched and saved.</small></span></label>
              <label className="switch"><input type="checkbox" checked={skipSeenCompanies} onChange={(e) => setSkipSeenCompanies(e.target.checked)} />
                <span>Skip companies already in my database<small>Only new companies are enriched and saved.</small></span></label>
              <label className="switch"><input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} />
                <span>Reuse recent lookups for free<small>Emails, phones and profiles found in the last 30–180 days. Switch off for fresh data.</small></span></label>
            </div>
          </div>

          <div className="card">
            <div className="card-h">Background job<span className="sub">optional</span></div>
            <div className="row">
              <label>Job name <input value={jobName} placeholder="e.g. SaaS founders US" onChange={(e) => setJobName(e.target.value)} /></label>
              <label>Repeat every (hours) <input type="number" min={0} value={repeatHours} placeholder="Run once" onChange={(e) => setRepeatHours(e.target.value)} /></label>
            </div>
            <p className="hint">A job runs in the background until done, even when this page is closed. It never spends more than the record budget.</p>
          </div>

          <div className="actionbar">
            <div className="primary-row">
              <button type="button" className="big-btn" onClick={() => void start()} disabled={running || !!pending || !steps.length || !!uploading}
                title="Run now with Max results from step 1, and watch it live"><IconPlay size={12} /> {pending === "start" ? "Starting…" : "Run now"}</button>
              <button type="button" className="secondary big-btn" onClick={createJob} disabled={creating || !steps.length || !!uploading}
                title="Add this pipeline to the job queue. It runs in the background until the list or search is done.">
                {creating ? "Creating…" : uploading ? "Uploading list…" : "Create job"}
              </button>
            </div>
            <div className="secondary-row">
              <button type="button" className="ghost small" onClick={testTen} disabled={running || !!pending || !steps.length || !!uploading} title="Run only the first 10 rows now, to check the results">Test 10 rows</button>
              <button type="button" className="ghost small" onClick={() => void estimateCost()} disabled={previewing || !steps.length}
                title="Estimate the cost. For a search this asks Blitz how many matches there are (uses 1 record).">
                {previewing ? "Checking…" : "Estimate cost"}
              </button>
              <button type="button" className="danger small" onClick={() => void stop()} disabled={!running || pending === "stop"}><IconStop size={11} /> {pending === "stop" ? "Stopping…" : "Stop"}</button>
            </div>
          </div>
          {preview && <div className="preview-line">{preview}</div>}
          {formError && <div className="error">{formError}</div>}
          {jobMsg && <div className="ok-line">{jobMsg}</div>}
        </section>

        </div>

        {/* ───────── Right: live view + results / activity ───────── */}
        <div className="col-right">
          <section className="panel live">
            <div className="panel-h">
              <div>
                <h2>Live pipeline {running && <span className="pill running"><span className="pulse-dot" />Running</span>}</h2>
                <div className="sub">{runId ? `Run ${runId}` : "Nothing running yet"}</div>
              </div>
              {stats && (
                <div className="budget">
                  <div className="budget-top"><span>Records used</span><span><b>{fmt(stats.records_used)}</b> / {fmt(stats.max_records)}</span></div>
                  <div className="budget-bar"><div style={{ width: `${budgetPct}%` }} /></div>
                </div>
              )}
            </div>
            {stats && running && (
              <div className="metrics">
                <div className="metric"><span>Speed</span><b>{speed ? Math.round(speed.perSec).toLocaleString() : "…"}</b><small>lookups / sec</small></div>
                <div className="metric"><span>Leads</span><b>{speed ? Math.round(speed.leadsPerMin).toLocaleString() : "…"}</b><small>per minute</small></div>
                <div className="metric"><span>Elapsed</span><b>{fmtDur(stats.elapsed ?? 0)}</b><small>since start</small></div>
                <div className="metric"><span>Time left</span><b>{speed?.eta != null ? fmtDur(speed.eta) : "…"}</b><small>{speed?.eta != null ? "estimated" : stats.source_done || stats.max_items ? "measuring" : "until the search ends"}</small></div>
              </div>
            )}
            {finished && stats && (
              <div className="summary">
                <div className="summary-h">
                  <span className={"pill " + (stats.status === "done" ? "done" : stats.status === "error" ? "failed" : "paused")}>
                    {stats.status === "done" ? "Finished" : stats.status === "error" ? "Failed" : "Stopped"}
                  </span>
                  <span className="muted">in {fmtDur(stats.elapsed ?? 0)}</span>
                  {runId && ((stats.saved ?? 0) > BIG_EXPORT
                    ? <button type="button" className="btn small" disabled={exp?.status === "queued" || exp?.status === "running"} onClick={() => void downloadRun("xlsx")}><IconDownload /> Download Excel</button>
                    : <a className="btn small" href={`/api/runs/${runId}/rows?fmt=xlsx`}><IconDownload /> Download Excel</a>)}
                </div>
                <div className="metrics">
                  <div className="metric"><span>Leads saved</span><b>{fmt(stats.saved)}</b><small>{stats.elapsed ? `${Math.round((stats.saved / stats.elapsed) * 60).toLocaleString()} per minute` : ""}</small></div>
                  {found("find_email") && <div className="metric"><span>Emails found</span><b>{found("find_email")!.pct}%</b><small>{fmt(found("find_email")!.hits)} emails</small></div>}
                  {found("find_phone") && <div className="metric"><span>Phones found</span><b>{found("find_phone")!.pct}%</b><small>{fmt(found("find_phone")!.hits)} phones</small></div>}
                  <div className="metric"><span>Records used</span><b>{fmt(stats.records_used)}</b><small>{stats.saved ? `${(stats.records_used / stats.saved).toFixed(1)} per lead` : "no leads saved"}</small></div>
                </div>
              </div>
            )}
            <div className="pipeline-view">
              {stats ? <Stages stats={stats} byId={byId} /> : (
                <div className="empty-state">
                  <b>Ready when you are</b>
                  Build your steps on the left, then press Run now or Test 10 rows.
                </div>
              )}
            </div>
            {runId && !running && (stats?.failed ?? 0) > 0 && (
              <div className="rerun-line">
                {stats!.failed} lead(s) had a step fail (see the <b>Failed step</b> column).
                <button type="button" className="small" onClick={() => void rerunFailed()} disabled={!!pending}><IconRefresh size={12} /> {pending === "rerun" ? "Re-running…" : "Re-run failed"}</button>
                <span className="muted">Only those leads, from the step that failed.</span>
              </div>
            )}
          </section>

          <section className="panel dock">
            <div className="dock-h">
              <div className="tabs">
                <button type="button" className={"tab" + (tab === "results" ? " on" : "")} onClick={() => setTab("results")}>
                  Results {rows.length > 0 && <span className="count">{rows.length.toLocaleString()}</span>}
                </button>
                <button type="button" className={"tab" + (tab === "activity" ? " on" : "")} onClick={() => setTab("activity")}>
                  Activity {logs.length > 0 && <span className="count">{logs.length.toLocaleString()}</span>}
                </button>
              </div>
              <div className="toolbar">
                {/* Only this run's leads here; everything else is on the Leads page. */}
                {runId && exp && exp.status !== "done" && (
                  <span className={exp.status === "failed" ? "error" : "muted"}>
                    {exp.status === "failed" ? `Export failed: ${exp.error}` : `Preparing file${exp.rows ? `: ${Number(exp.rows).toLocaleString()} rows` : ""}…`}
                  </span>
                )}
                {runId && exp?.status === "done" && exp.url && <a className="muted" href={exp.url}>File ready, download again</a>}
                {runId && (["csv", "xlsx"] as const).map((fmt) => (stats?.saved ?? 0) > BIG_EXPORT ? (
                  <button key={fmt} type="button" className="secondary small" disabled={exp?.status === "queued" || exp?.status === "running"}
                    onClick={() => void downloadRun(fmt)} title="Large run: the file is built in the background, then downloads by itself">
                    <IconDownload /> {fmt === "csv" ? "CSV" : "Excel"}
                  </button>
                ) : (
                  <a key={fmt} className="btn secondary small" href={`/api/runs/${runId}/rows?fmt=${fmt}`}
                    title={running ? "The leads this run has saved so far" : "Every lead this run saved"}><IconDownload /> {fmt === "csv" ? "CSV" : "Excel"}</a>
                ))}
              </div>
            </div>
            {tab === "results" ? (
              <div className="table-wrap fill">
                <table>
                  <thead><tr>{(columns.length ? columns : ["full_name", "job_title", "email", "phone", "company_name"]).map((c) => <th key={c}>{humanize(c)}</th>)}</tr></thead>
                  <tbody>
                    {shown.length === 0 ? (
                      <tr className="empty"><td colSpan={Math.max(columns.length, 5)}>No rows yet. Leads show up here live, the moment they finish the last step.</td></tr>
                    ) : shown.map((r, i) => (
                      <tr key={rows.length - i} className={i < newestCount ? "new" : undefined}>
                        {columns.map((c) => <Cell key={c} row={r} col={c} />)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ol id="log" className="fill">
                {logs.map((ev, i) => (
                  <li key={logs.length - i}><span className="t">{(ev.at / 1000).toFixed(1)}s</span><span className="s">{ev.stage}</span><span>{ev.message}</span></li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

/** Above this many leads a run's download is built in the background (a streamed one would time out). */
const BIG_EXPORT = 50_000;

function Cell({ row, col }: { row: Row; col: string }) {
  const v = row[col];
  if (v === undefined) {
    const status = col === "email" ? row.email_status : col === "phone" ? row.phone_status : "";
    return <td><span className="none">{String(status || "").replace(/_/g, " ")}</span></td>;
  }
  if (/_url$/.test(col)) return <td><a href={String(v)} target="_blank" rel="noopener">link</a></td>;
  return <td title={String(v)}>{String(v).slice(0, 60)}</td>;
}

/** One small "number + word" fact under a stage. Zero values are left out to keep rows calm. */
function Fact({ n, label, cls = "" }: { n: number; label: string; cls?: string }) {
  return <span className={"fact " + cls}><b>{Number(n).toLocaleString()}</b> {label}</span>;
}

const STATE: Record<string, string> = { running: "Working", done: "Done", stopped: "Stopped", error: "Error" };

/** The live pipeline as a vertical flow: one calm row per step, a progress bar, and only the numbers that matter. */
function Stages({ stats, byId }: { stats: RunStats; byId: Record<string, CatalogStep> }) {
  const hitLabels: Record<string, string> = { expand: "found", enrich: "found", filter: "kept", send: "sent" };
  const allDone = stats.stages.every((s) => s.status !== "running");
  return (
    <div className="flow">
      {stats.stages.map((s, i) => {
        const first = i === 0;
        const busy = s.status === "running" && (first || s.in_flight > 0);
        const cls = s.status === "running" ? (busy ? "running" : "idle") : s.status;
        const count = first ? s.out + s.duplicates : s.done;
        const queued = s.done + s.in_flight + s.waiting;
        // progress: later steps = processed / everything handed to them; step 1 = results / Max results (if set)
        const pct = first
          ? (stats.max_items ? Math.min(100, (count / stats.max_items) * 100) : s.status === "running" ? null : 100)
          : queued ? (s.done / queued) * 100 : s.status === "running" ? 0 : 100;
        const hitLabel = hitLabels[s.group];
        const hitPct = hitLabel && s.done ? Math.round((s.hits / s.done) * 100) : null;
        return (
          <div key={i} className={"flow-row " + cls}>
            <span className="num">{i + 1}</span>
            <div className="flow-main">
              <div className="flow-top">
                <b title={s.label}>{s.label}</b>
                <span className={"group-tag " + s.group}>{s.group}</span>
                <span className="flow-state"><span className="dot" />{STATE[s.status] ?? (busy ? "Working" : "Waiting")}</span>
              </div>
              <div className={"flow-bar" + (pct == null ? " indeterminate" : "")}><div style={{ width: pct == null ? undefined : `${pct}%` }} /></div>
              <div className="flow-facts">
                {!first && s.in_flight > 0 && <Fact n={s.in_flight} label="working" />}
                {!first && s.waiting > 0 && <Fact n={s.waiting} label="waiting" />}
                {hitLabel && s.hits > 0 && <span className="fact good"><b>{s.hits.toLocaleString()}</b> {hitLabel}{hitPct != null && <em>{hitPct}%</em>}</span>}
                {s.dedupe_on && s.duplicates > 0 && <Fact n={s.duplicates} label={`duplicate ${s.dedupe_on}s skipped`} />}
                {s.filtered > 0 && <Fact n={s.filtered} label="removed by filter" />}
                {s.skipped > 0 && <Fact n={s.skipped} label={`skipped (no ${byId[s.id]?.needs ?? "input"})`} />}
                {s.errors > 0 && <Fact n={s.errors} label="errors" cls="bad" />}
                {(s.cached ?? 0) > 0 && <Fact n={s.cached ?? 0} label="from cache" />}
                <Fact n={s.records} label="records" cls="quiet" />
              </div>
            </div>
            <div className="flow-count"><b>{count.toLocaleString()}</b><small>{first ? "results" : "processed"}</small></div>
          </div>
        );
      })}
      <div className={"flow-row save " + (allDone ? "done" : "")}>
        <span className="num"><IconCheck size={12} /></span>
        <div className="flow-main">
          <div className="flow-top"><b>Saved leads</b></div>
          <div className="flow-facts"><span className="fact quiet">Rows that finished every step</span></div>
        </div>
        <div className="flow-count"><b>{stats.saved.toLocaleString()}</b><small>saved</small></div>
      </div>
    </div>
  );
}
