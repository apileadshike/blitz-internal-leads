"use client";
// Turns a JSON schema (from Blitz's OpenAPI spec) into a form.
// Every field is controlled: `value` in, `onChange(newValue)` out.
// Empty values are cleaned out when the pipeline is sent (see cleanParams).
import { useEffect, useId, useState } from "react";

type S = Record<string, any>;
type FieldProps = { name: string; schema: S; value: any; onChange: (v: any) => void };

// Fields shown up front; everything else goes under "More filters".
const COMMON = new Set([
  "company", "people", "job", "list", "cascade", "us_only",
  "industry", "employee_range", "hq", "keywords", "country_code", "type",
  "job_title", "job_level", "job_function", "location", "title", "include_title", "exclude_title",
  "max_results", "is_recent_hire", "date_posted", "seniority", "name", "size",
  // custom (non-Blitz) step settings
  "run_id", "decision_makers", "champions", "users", "per_role", "only_changed",
  "industries", "company_sizes", "countries", "title_keywords", "exclude_title_keywords", "drop_non_fit",
  "watch_name", "on", "apps_script_url", "url", "auth_header",
]);

export const humanize = (k: string) =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bHq\b/, "HQ").replace(/\bIcp\b/, "ICP").replace(/\bMx\b/, "MX");

const norm = (s: S | undefined): S => (s?.anyOf ? s.anyOf.find((x: S) => x.type !== "null") ?? s.anyOf[0] : s ?? {});
const isSimple = (raw: S) => { const s = norm(raw); return s.type !== "object" && !(s.type === "array" && norm(s.items).type === "object"); };

/** Drop empty strings, empty lists and empty objects, recursively. */
export function cleanParams(v: any): any {
  if (Array.isArray(v)) {
    const out = v.map(cleanParams).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out: S = {};
    for (const [k, x] of Object.entries(v)) { const c = cleanParams(x); if (c !== undefined) out[k] = c; }
    return Object.keys(out).length ? out : undefined;
  }
  return v === "" || v === null ? undefined : v;
}

/** The top-level settings of one step. */
export function StepForm({ schema, value, onChange }: { schema: S; value: S; onChange: (v: S) => void }) {
  return <ObjectField name="" schema={schema} value={value} onChange={onChange} top />;
}

function Field(p: FieldProps & { depth?: number }) {
  const s = norm(p.schema);
  if (s.type === "object" && s.properties) return <ObjectField {...p} schema={s} />;
  if (s.type === "array") {
    const items = norm(s.items);
    if (items.enum) return items.enum.length <= 40 ? <Checks {...p} schema={s} options={items.enum} /> : <Chips {...p} schema={s} options={items.enum} />;
    if (items.type === "object") return <Repeat {...p} schema={s} itemSchema={items} />;
    return <ListField {...p} schema={s} numeric={items.type === "number" || items.type === "integer"} />;
  }
  if (s.type === "boolean") return <Bool {...p} schema={s} />;
  if (s.type === "number" || s.type === "integer") return <NumberField {...p} schema={s} />;
  if (s.enum) return <Select {...p} schema={s} />;
  return <Text {...p} schema={s} />;
}

function ObjectField({ name, schema, value, onChange, top }: FieldProps & { top?: boolean }) {
  const v: S = value ?? {};
  const props = Object.entries((schema.properties ?? {}) as Record<string, S>);
  const set = (k: string, x: any) => onChange({ ...v, [k]: x });
  const field = ([k, p]: [string, S]) => <Field key={k} name={k} schema={p} value={v[k]} onChange={(x) => set(k, x)} />;

  // Small all-simple objects (include/exclude, min/max) render inline on one row.
  if (!top && props.length <= 3 && props.every(([, p]) => isSimple(p))) {
    return (
      <div className="field">
        <div className="flabel" title={schema.description ?? ""}>{humanize(name)}</div>
        <div className="row tight">{props.map(field)}</div>
      </div>
    );
  }
  const shown = props.filter(([k]) => COMMON.has(k) || v[k] !== undefined);
  const more = props.filter(([k]) => !(COMMON.has(k) || v[k] !== undefined));
  const body = (
    <>
      {shown.map(field)}
      {more.length > 0 && (
        <details className="more">
          <summary>More {top ? "settings" : humanize(name).toLowerCase() + " filters"} ({more.length})</summary>
          {more.map(field)}
        </details>
      )}
    </>
  );
  if (top) return <div>{body}</div>;
  return (
    <fieldset className="obj">
      <legend title={schema.description ?? ""}>{humanize(name)}</legend>
      {body}
    </fieldset>
  );
}

function Labelled({ name, schema, children, className }: { name: string; schema: S; children: React.ReactNode; className?: string }) {
  return <label title={schema.description ?? ""} className={className}>{humanize(name)}{children}</label>;
}

function Text({ name, schema, value, onChange }: FieldProps) {
  const ph = schema.description ? String(schema.description).slice(0, 60) : undefined;
  const set = (x: string) => onChange(x.trim() ? x : undefined);
  return (
    <Labelled name={name} schema={schema}>
      {schema.format === "textarea"
        ? <textarea rows={6} value={value ?? ""} placeholder={ph} onChange={(e) => set(e.target.value)} />
        : <input value={value ?? ""} placeholder={ph} onChange={(e) => set(e.target.value)} />}
    </Labelled>
  );
}

function NumberField({ name, schema, value, onChange }: FieldProps) {
  const lo: number | undefined = schema.minimum, hi: number | undefined = schema.maximum;
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [clamped, setClamped] = useState(false);
  useEffect(() => { setDraft(value === undefined ? "" : String(value)); }, [value]);
  // Pull typed values back into the range the API accepts (e.g. Waterfall max results ≤ 100).
  const commit = () => {
    if (draft === "") return onChange(undefined);
    let n = Number(draft);
    if (!Number.isFinite(n)) return onChange(undefined);
    if (lo !== undefined && n < lo) n = lo;
    if (hi !== undefined && n > hi) n = hi;
    if (String(n) !== draft) { setClamped(true); setTimeout(() => setClamped(false), 1200); }
    setDraft(String(n));
    onChange(n);
  };
  const range = lo !== undefined && hi !== undefined ? ` (${lo}–${hi})` : hi !== undefined ? ` (max ${hi})` : "";
  return (
    <Labelled name={name + range} schema={schema}>
      <input type="number" min={lo} max={hi} className={clamped ? "clamped" : undefined}
        placeholder={schema.default !== undefined && schema.default !== 0 ? `default ${schema.default}` : ""}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </Labelled>
  );
}

function Bool({ name, schema, value, onChange }: FieldProps) {
  const dflt = schema.default ?? false;
  const checked = value ?? dflt;
  return (
    <label className="inline" title={schema.description ?? ""}>
      {/* only sent when it differs from the API default */}
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked === dflt ? undefined : e.target.checked)} /> {humanize(name)}
    </label>
  );
}

function Select({ name, schema, value, onChange }: FieldProps) {
  return (
    <Labelled name={name} schema={schema}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(any)</option>
        {(schema.enum as string[]).map((o) => <option key={o}>{o}</option>)}
      </select>
    </Labelled>
  );
}

/** Free-text list: comma separated. */
function ListField({ name, schema, value, onChange, numeric }: FieldProps & { numeric: boolean }) {
  const [draft, setDraft] = useState(((value as unknown[]) ?? []).join(", "));
  const parse = (text: string) => {
    const v = text.split(",").map((x) => x.trim()).filter(Boolean);
    return v.length ? (numeric ? v.map(Number) : v) : undefined;
  };
  // Value changed from outside (e.g. a tier above was removed): show it.
  useEffect(() => {
    if (JSON.stringify(parse(draft) ?? []) !== JSON.stringify(value ?? [])) setDraft(((value as unknown[]) ?? []).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  const update = (text: string) => { setDraft(text); onChange(parse(text)); };
  return (
    <Labelled name={name} schema={schema}>
      <input placeholder="comma separated" value={draft} onChange={(e) => update(e.target.value)} />
    </Labelled>
  );
}

function Checks({ name, schema, value, onChange, options }: FieldProps & { options: string[] }) {
  const set = new Set<string>(value ?? []);
  const toggle = (o: string, on: boolean) => {
    on ? set.add(o) : set.delete(o);
    const v = options.filter((x) => set.has(x));
    onChange(v.length ? v : undefined);
  };
  return (
    <div className="field">
      <div className="flabel" title={schema.description ?? ""}>{humanize(name)}</div>
      <div className={"checks" + (options.length > 10 ? " small" : "")}>
        {options.map((o) => (
          <label key={o}><input type="checkbox" checked={set.has(o)} onChange={(e) => toggle(o, e.target.checked)} />{o}</label>
        ))}
      </div>
    </div>
  );
}

/** Searchable multi-select for long enums (e.g. 534 industries). */
function Chips({ name, schema, value, onChange, options }: FieldProps & { options: string[] }) {
  const id = useId();
  const [text, setText] = useState("");
  const selected: string[] = value ?? [];
  const tryAdd = (v: string) => {
    const match = options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
    if (!match) return false;
    if (!selected.includes(match)) onChange([...selected, match]);
    setText("");
    return true;
  };
  const remove = (v: string) => { const next = selected.filter((x) => x !== v); onChange(next.length ? next : undefined); };
  return (
    <div className="field">
      <div className="flabel" title={schema.description ?? ""}>{humanize(name)}</div>
      <div className="chips">
        {selected.map((v) => <span key={v} className="chip" onClick={() => remove(v)}>{v} ✕</span>)}
      </div>
      <input list={id} placeholder={`Type to search ${options.length} options`} value={text}
        onChange={(e) => { if (!tryAdd(e.target.value)) setText(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); tryAdd(text); } }} />
      <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </div>
  );
}

/** Array of objects, e.g. Waterfall cascade tiers. */
function Repeat({ name, schema, value, onChange, itemSchema }: FieldProps & { itemSchema: S }) {
  const entries: S[] = value?.length ? value : [{}];
  const label = name === "cascade" ? "Tier" : "Item";
  return (
    <fieldset className="obj">
      <legend title={schema.description ?? ""}>{humanize(name)}</legend>
      {entries.map((entry, i) => (
        <div className="repeat" key={i}>
          <div className="row between">
            <b>{label} {i + 1}</b>
            <button type="button" className="link" onClick={() => onChange(entries.filter((_, j) => j !== i))}>remove</button>
          </div>
          <ObjectField name="" schema={itemSchema} value={entry} top
            onChange={(x) => onChange(entries.map((e, j) => (j === i ? x : e)))} />
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => onChange([...entries, {}])}>+ Add {label.toLowerCase()}</button>
    </fieldset>
  );
}
