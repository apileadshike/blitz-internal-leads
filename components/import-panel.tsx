"use client";
// Import a file into the builder: pick (or accept) the column with the identifiers,
// fill step 1 with the list, and keep the file's other columns for the results.
import { ID_TYPES, normalize, type IdType } from "@/lib/idtypes";

export type ImportResult = {
  file: string; headers: string[]; rows: string[][]; truncated: boolean;
  columns: { index: number; name: string; type: IdType | null; matches: number; filled: number; sample: string[] }[];
  suggestion: { column: number; type: IdType } | null;
};
/** combine: use the LinkedIn company URL when a row has one, the domain otherwise (one job, fewer paid lookups). */
export type ImportState = { result: ImportResult; column: number; type: IdType; keep: boolean; combine?: boolean };

const COMPANY: IdType[] = ["domain", "company_url"];
const PERSON: IdType[] = ["person_url", "email", "phone"];
const bestCol = (r: ImportResult, t: IdType) =>
  r.columns.filter((c) => c.type === t).sort((a, b) => b.matches - a.matches)[0];

/** The LinkedIn-company + domain column pair, if the file has both. */
export function companyPair(r: ImportResult) {
  const li = bestCol(r, "company_url"), dom = bestCol(r, "domain");
  return li && dom ? { li: li.index, dom: dom.index } : null;
}
/** Is the LinkedIn-first / domain-fallback mode in use? */
export const combining = (st: ImportState) => !!st.combine && COMPANY.includes(st.type) && !!companyPair(st.result);
/** The list step for this import. */
export const sourceFor = (st: ImportState) => (combining(st) ? "list_domains" : ID_TYPES[st.type].source);

/** A column holding the other kind of lead (people vs companies): it can become its own job. */
export function otherKinds(st: ImportState) {
  const mine = COMPANY.includes(st.type) ? COMPANY : PERSON;
  const pair = companyPair(st.result);
  const used = combining(st) && pair ? [pair.li, pair.dom] : [st.column];
  return st.result.columns
    .filter((c) => c.type && !mine.includes(c.type) && !used.includes(c.index))
    .sort((a, b) => b.matches - a.matches)
    .slice(0, 1)
    .map((c) => ({ column: c.index, type: c.type!, name: c.name }));
}

/** Steps added after the list when the current steps don't fit the imported kind. */
export const DEFAULT_CHAIN: Record<IdType, { step: string; params: Record<string, any> }[]> = {
  domain: [
    { step: "waterfall_icp", params: { max_results: 1, cascade: [{ include_title: ["[CEO]", "Founder", "Co-Founder"] }, { include_title: ["VP Sales", "Head of Sales", "CRO"] }] } },
    { step: "find_email", params: {} },
    { step: "find_phone", params: {} },
  ],
  company_url: [
    { step: "waterfall_icp", params: { max_results: 1, cascade: [{ include_title: ["[CEO]", "Founder", "Co-Founder"] }, { include_title: ["VP Sales", "Head of Sales", "CRO"] }] } },
    { step: "find_email", params: {} },
    { step: "find_phone", params: {} },
  ],
  person_url: [{ step: "person_enrichment", params: {} }, { step: "find_email", params: {} }, { step: "find_phone", params: {} }],
  email: [{ step: "find_phone", params: {} }],
  phone: [{ step: "find_email", params: {} }],
};

export const baseName = (file: string) => file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();

/** The unique values for step 1, plus the other columns of each row (keyed by value). */
export function buildImport(st: ImportState) {
  const { rows, headers } = st.result;
  const values: string[] = [];
  const seen = new Set<string>();
  const inputRows: Record<string, Record<string, string>> = {};
  const pair = combining(st) ? companyPair(st.result)! : null;
  const keepCols = headers.map((h, i) => [h, i] as const).filter(([, i]) => i !== st.column).slice(0, 30);
  let domainsLeft = 0;
  for (const r of rows) {
    // Combined: the LinkedIn URL when the row has one, the domain otherwise.
    const li = pair ? r[pair.li] : "", dom = pair ? r[pair.dom] : "";
    const raw = pair ? li || dom : r[st.column];
    if (!raw) continue;
    const v = pair ? (li ? normalize("company_url", li) : normalize("domain", dom)) : normalize(st.type, raw);
    if (pair && !li && v && !seen.has(v)) domainsLeft++;
    if (!v || seen.has(v)) continue;
    seen.add(v);
    values.push(v);
    if (st.keep) {
      const o: Record<string, string> = {};
      for (const [h, i] of keepCols) if (r[i]) o[h] = r[i];
      if (Object.keys(o).length) inputRows[v] = o;
    }
  }
  return {
    values, inputRows: st.keep && Object.keys(inputRows).length ? inputRows : undefined, keptColumns: st.keep ? keepCols.length : 0,
    // How many step-1 values cost a lookup (combined mode: only the domains).
    paidFirst: pair ? domainsLeft : values.length,
  };
}

export function ImportPanel({ state, onChange, onClose, estimate, onSideJob, sideJobMsg }: {
  state: ImportState; onChange: (s: ImportState) => void; onClose: () => void; estimate: number | null;
  onSideJob: (column: number, type: IdType) => void; sideJobMsg: React.ReactNode;
}) {
  const pair = companyPair(state.result);
  const others = otherKinds(state);
  const { result } = state;
  const built = buildImport(state);
  const col = result.columns[state.column];
  return (
    <div className="import-panel">
      <div className="row between">
        <b>📄 {result.file}</b>
        <button type="button" className="link" onClick={onClose} title="Hide (the list stays in step 1)">✕</button>
      </div>
      <div className="muted">{result.rows.length.toLocaleString()} rows{result.truncated ? " (only the first 100,000 were read)" : ""}</div>
      <div className="row tight">
        <label>Column
          <select value={state.column} onChange={(e) => onChange({ ...state, column: Number(e.target.value), type: result.columns[Number(e.target.value)].type ?? state.type })}>
            {result.columns.map((c) => (
              <option key={c.index} value={c.index}>{c.name}{c.type ? ` · ${ID_TYPES[c.type].label.toLowerCase()} (${c.matches})` : ""}</option>
            ))}
          </select>
        </label>
        <label>Contains
          <select value={state.type} onChange={(e) => onChange({ ...state, type: e.target.value as IdType })}>
            {(Object.keys(ID_TYPES) as IdType[]).map((t) => <option key={t} value={t}>{ID_TYPES[t].label}</option>)}
          </select>
        </label>
      </div>
      {col?.sample.length ? <div className="muted">e.g. {col.sample.join(" · ")}</div> : null}
      {result.headers.length > 1 && (
        <label className="inline">
          <input type="checkbox" checked={state.keep} onChange={(e) => onChange({ ...state, keep: e.target.checked })} />
          Keep my file&apos;s other columns in the results ({Math.min(30, result.headers.length - 1)} columns, as in_…)
        </label>
      )}
      {pair && COMPANY.includes(state.type) && (
        <label className="inline">
          <input type="checkbox" checked={!!state.combine} onChange={(e) => onChange({ ...state, combine: e.target.checked })} />
          Use the LinkedIn URL when a row has one, the domain otherwise
          {combining(state) && <span className="muted">&nbsp;({(built.values.length - built.paidFirst).toLocaleString()} free, {built.paidFirst.toLocaleString()} domain lookups)</span>}
        </label>
      )}
      {others.map((o) => (
        <div key={o.column} className="muted">
          This file also has <b>{ID_TYPES[o.type].label.toLowerCase()}</b> in column &quot;{o.name}&quot;.{" "}
          <button type="button" className="secondary small" onClick={() => onSideJob(o.column, o.type)}>+ Create a separate job for them</button>
        </div>
      ))}
      {sideJobMsg && <div className="ok-line">{sideJobMsg}</div>}
      <div className={built.values.length ? "ok-line" : "error"}>
        {built.values.length
          ? <>✓ {built.values.length.toLocaleString()} unique {combining(state) ? "companies" : ID_TYPES[state.type].label.toLowerCase()} filled into step 1.
              {estimate !== null && <> Estimated cost: up to <b>{estimate.toLocaleString()}</b> records (record budget set to this).</>}</>
          : "No values found in this column. Pick another column."}
      </div>
    </div>
  );
}

/** Most records the pipeline could use for `n` input rows (lookups that find nothing are free, so real spend is usually lower). */
export function estimateRecords(
  steps: { id: string; params: Record<string, any> }[],
  byId: Record<string, { endpoint: string; group: string }>,
  n: number,
  firstPaid = n, // step-1 values that cost a lookup (e.g. only the domains in a mixed company list)
): number {
  let items = n, cost = 0;
  for (const [i, s] of steps.entries()) {
    const def = byId[s.id];
    if (!def) continue;
    const paid = /^POST /.test(def.endpoint);
    if (i === 0) { if (paid) cost += firstPaid; continue; }
    if (def.group === "expand") {
      const per = Number(s.params.max_results ?? (s.params.per_role ? s.params.per_role * 3 : 1)) || 1;
      cost += items * per;
      items *= per;
    } else if (paid) cost += items;
  }
  return Math.ceil(cost);
}
