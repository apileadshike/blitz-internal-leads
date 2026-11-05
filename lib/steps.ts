// Every Blitz endpoint that can be a pipeline step.
//
// A pipeline item carries up to three records: company, person, job. Field names
// are already the final spreadsheet column names, so saving is just a merge.
//
//   source  → produces items from filters or a pasted list   (always step 1)
//   expand  → one item in, many out (company → its people / its jobs)
//   enrich  → one item in, same item out with more columns
import { INDUSTRY, EMPLOYEE_RANGE, JOB_LEVEL, JOB_FUNCTION, CONTINENT, type BlitzAPI } from "blitz-api-js";
import { flatten, normUrl, savedPeople, uploadRows, watchIsNew } from "./db";

export type Entity = "company" | "person" | "job";
export type Rec = Record<string, unknown>;
export type Item = {
  company?: Rec; person?: Rec; job?: Rec; extra: Rec;
  /** Stable id of this lead in the queue (a re-run replaces the saved row with this key). */
  key?: string;
  /** Put back by "Re-run failed": skips the duplicate check once (it already passed it). */
  rerun?: boolean;
};

/** What a step can use while running. */
export type StepCtx = {
  client: BlitzAPI;
  stopped(): boolean;
  /** Pass any API response; counts its fair_usage.records_used. */
  charge(resp: unknown): void;
  hit(): void; // a lookup that found something
  log(msg: string): void;
  maxItems: number; // sources only (Infinity = everything)
  concurrency: number;
  /** Continue a search from this cursor (the queue fetches one page at a time). */
  startCursor?: string;
  /** Pages already fetched by this run (for log numbering). */
  pagesDone?: number;
  /** Called after every page with the cursor for the next page (null = no more results). */
  saveCursor(cursor: string | null): void;
  /** Called with Blitz's "how many match" number, when a page reports it. */
  onTotal?(total: number): void;
};

export type StepDef = {
  id: string;
  label: string;
  endpoint: string;
  group: "source" | "expand" | "enrich" | "filter" | "send";
  help: string;
  needs?: Entity; // input requirement (expand/enrich)
  gives: Entity[]; // records this step adds to the item
  /** Duplicate check runs on this record right after the step. */
  dedupeOn?: Entity;
  /** OpenAPI path whose request body becomes the step's settings form. */
  schemaPath?: string;
  /** Request fields the engine fills itself (input URLs, paging). */
  omit?: string[];
  /** Extra non-API settings (JSON schema properties). */
  extraParams?: Record<string, unknown>;
  /** Source fed by a pasted list instead of filters. */
  listInput?: { placeholder: string };
  source?: (params: Rec, ctx: StepCtx) => AsyncGenerator<Item>;
  expand?: (item: Item, params: Rec, ctx: StepCtx) => AsyncGenerator<Item>;
  /** Return false to drop the row (filters). */
  enrich?: (item: Item, params: Rec, ctx: StepCtx) => Promise<void | boolean>;
  /** Don't apply the "skip already in my database" option after this step. */
  noHistorySkip?: boolean;
  /** Setup guide link shown in the UI. */
  docs?: string;
  /** Always call the API, never the cache (steps that look for changes). */
  noCache?: boolean;
  /** Cap workers for this step (e.g. Google Sheets can't take 20 writes at once). */
  maxConcurrency?: number;
  /**
   * Search sources only: filters a search can be split on, so several parts page at the same
   * time (one cursor each). Every result must belong to exactly one value of the filter.
   */
  split?: SplitDim[];
};

/**
 * A filter a search can be split on. `all`: values to split into when the filter is left empty.
 * `refineOnly`: that full list is only used to split a part that has more matches than Blitz
 * returns per search (not for the first split), because not every record may have a value.
 */
export type SplitDim = { path: string[]; label: string; all?: readonly string[]; refineOnly?: boolean; maxItems?: number };
// Checked against Blitz (people search): job level, job function, company HQ continent and industry
// each cover ~100% of the matches. Person continent covered only 89%, so it is not used.

/** Blitz returns at most this many results for one search, however many match. */
export const SEARCH_CAP = 50_000;

// Where each search keeps its splittable filters (see the Blitz request types).
const COMPANY_SPLITS: SplitDim[] = [
  // Every company has exactly one size band: all 8 bands together cover the whole search
  // (checked against Blitz: the parts add up to the unsplit total, about 1% overlap).
  { path: ["company", "employee_range"], label: "employee range", all: EMPLOYEE_RANGE },
  { path: ["company", "hq", "country_code"], label: "HQ country" },
  { path: ["company", "industry", "include"], label: "industry", all: INDUSTRY, refineOnly: true, maxItems: 50 },
  { path: ["company", "hq", "continent"], label: "HQ continent", all: CONTINENT, refineOnly: true },
];
const PEOPLE_SPLITS: SplitDim[] = [
  ...COMPANY_SPLITS,
  { path: ["people", "location", "country_code"], label: "person country" },
  { path: ["people", "job_level"], label: "job level", all: JOB_LEVEL, refineOnly: true },
  { path: ["people", "job_function"], label: "job function", all: JOB_FUNCTION, refineOnly: true },
];
const JOB_SPLITS: SplitDim[] = [
  { path: ["company", "size", "include"], label: "company size" },
  { path: ["company", "hq", "country_code", "include"], label: "HQ country" },
  { path: ["job", "location", "country_code", "include"], label: "job country" },
  { path: ["company", "industry", "include"], label: "industry" },
  { path: ["job", "seniority", "include"], label: "seniority" },
];

/** Most search parts paged at the same time for one run. */
export const MAX_SPLITS = Math.max(1, Number(process.env.SEARCH_SPLITS ?? 8));

/**
 * Split a search into parts that don't overlap, so they can be paged at the same time.
 * Uses the filter that gives the most parts: one the user filled with several values,
 * or one left empty that has a known full list (employee range). One part = no split.
 * `refine`: splitting a part that has too many matches; also uses the refine-only lists
 * (job level, job function, continent, industry), the smallest list that gives `max` parts first.
 */
export function splitSearch(def: StepDef, params: Rec, max = MAX_SPLITS, refine = false): { label: string; params: Rec | null }[] {
  const whole = [{ label: "", params: null }];
  if (!def.split || max < 2) return whole;
  let best: { dim: SplitDim; values: string[] } | undefined;
  const rank = (n: number) => (refine ? (n >= max ? 1000 - n : n) : n); // refine: enough parts, fewest groups
  for (const dim of def.split) {
    const cur = getPath(params, dim.path);
    const empty = cur == null || (Array.isArray(cur) && !cur.length);
    const values = Array.isArray(cur) && cur.length ? cur.map(String) : empty && dim.all && (refine || !dim.refineOnly) ? [...dim.all] : [];
    if (values.length >= 2 && (!best || rank(values.length) > rank(best.values.length))) best = { dim, values };
  }
  if (!best) return whole;
  // More values than parts: group them (e.g. 12 countries into 8 parts).
  // Blitz takes at most maxItems values in one filter (industry: 50), so a long list may need more groups.
  const n = Math.max(Math.min(max, best.values.length), Math.ceil(best.values.length / (best.dim.maxItems ?? Infinity)));
  const groups: string[][] = Array.from({ length: n }, () => []);
  best.values.forEach((v, i) => groups[i % n].push(v));
  const name = (g: string[]) => (g.length > 3 ? `${g.slice(0, 2).join(", ")} +${g.length - 2} more` : g.join(", "));
  return groups.map((g) => ({ label: `${best!.dim.label} ${name(g)}`, params: setPath(structuredClone(params), best!.dim.path, g) }));
}

function getPath(o: unknown, path: string[]): unknown {
  return path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Rec)[k] : undefined), o);
}
function setPath(o: Rec, path: string[], v: unknown): Rec {
  let cur = o;
  for (const k of path.slice(0, -1)) cur = (cur[k] && typeof cur[k] === "object" ? cur[k] : (cur[k] = {})) as Rec;
  cur[path[path.length - 1]] = v;
  return o;
}

// ── record builders ──────────────────────────────────────────────────────────
type AnyObj = Record<string, any>; // API objects (SDK keeps unknown fields)

export function companyRec(c: AnyObj): Rec {
  return {
    company_name: c.name, company_domain: c.domain, company_website: c.website,
    company_linkedin_url: c.linkedin_url, company_industry: c.industry, company_type: c.type,
    company_size: c.size, company_employees: c.employees_on_linkedin, company_followers: c.followers,
    company_founded_year: c.founded_year, company_revenue_range: c.revenue_range,
    company_hq_city: c.hq?.city, company_hq_state: c.hq?.state, company_hq_country: c.hq?.country_code,
  };
}

function personRec(p: AnyObj): Rec {
  return {
    full_name: p.full_name, first_name: p.first_name, last_name: p.last_name,
    job_title: currentJob(p)?.job_title, headline: p.headline,
    person_linkedin_url: p.linkedin_url, connections: p.connections_count,
    city: p.location?.city, state: p.location?.state_code, country: p.location?.country_code,
  };
}

function currentJob(p: AnyObj): AnyObj | undefined {
  return p.experiences?.find((x: AnyObj) => x.job_is_current) ?? p.experiences?.[0];
}

/** Person item. Inherits the parent's company/extra; fills company from the current job if missing. */
function personItem(p: AnyObj, parent?: Item): Item {
  const item: Item = { company: parent?.company && { ...parent.company }, person: personRec(p), extra: { ...parent?.extra } };
  const job = currentJob(p);
  if (!item.company && job?.company_linkedin_url) {
    item.company = { company_name: job.company_name, company_domain: job.company_domain, company_linkedin_url: job.company_linkedin_url };
  }
  return item;
}

function jobRec(j: AnyObj): Rec {
  return {
    job_posting_title: j.title, job_posting_url: j.url, job_posted_at: j.date_posted,
    job_location: [j.location?.city, j.location?.country_code].filter(Boolean).join(", "),
    job_summary: j.ai_summary,
  };
}

const companyUrl = (i: Item) => i.company?.company_linkedin_url as string;
const personUrl = (i: Item) => i.person?.person_linkedin_url as string;

// ── helpers ──────────────────────────────────────────────────────────────────
type Paged = PromiseLike<{ data: AnyObj[]; response: AnyObj }>;

/** Cursor paging that never pulls (or pays for) more than ctx.maxItems. */
async function* cursorPaged(call: (p: Rec) => Paged, params: Rec, ctx: StepCtx): AsyncGenerator<AnyObj> {
  let remaining = ctx.maxItems;
  let cursor: string | undefined = ctx.startCursor;
  let pageNo = ctx.pagesDone ?? 0;
  while (remaining > 0 && !ctx.stopped()) {
    const page = await call({ ...params, max_results: Math.min(50, remaining), ...(cursor ? { cursor } : {}) });
    ctx.charge(page.response);
    pageNo++;
    const total = page.response.total_results;
    if (total != null) ctx.onTotal?.(Number(total));
    ctx.log(`Page ${pageNo}: ${page.data.length} results${total != null ? ` (${Number(total).toLocaleString()} match in Blitz)` : ""}`);
    for (const x of page.data.slice(0, remaining)) yield x;
    remaining -= page.data.length;
    cursor = page.response.cursor ?? undefined;
    ctx.saveCursor(cursor ?? null);
    if (!cursor) ctx.log("Reached the end of this search (no more results)");
    if (!cursor || page.data.length === 0) break;
  }
}

/** Run fn over a pasted list with `n` lookups in flight, yielding results as they finish. */
async function* mapConcurrent<T>(inputs: string[], ctx: StepCtx, fn: (s: string) => Promise<T | undefined>): AsyncGenerator<T> {
  const done: (T | undefined)[] = [];
  let wake: (() => void) | null = null;
  let next = 0, running = 0;
  const launch = () => {
    while (running < ctx.concurrency && next < inputs.length && !ctx.stopped()) {
      const input = inputs[next++];
      running++;
      fn(input)
        .catch((e) => { ctx.log(`"${input}": ${e?.message ?? e}`); return undefined; })
        .then((r) => { running--; done.push(r); wake?.(); });
    }
  };
  launch();
  while (running > 0 || done.length > 0) {
    if (done.length === 0) await new Promise<void>((r) => (wake = r));
    wake = null;
    while (done.length) { const r = done.shift(); if (r !== undefined) yield r; }
    launch();
  }
}

const lines = (params: Rec) =>
  [...new Set(String(params.list ?? "").split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean))];

const LIST_SCHEMA = { list: { type: "string", format: "textarea", description: "One per line, or use Import file" } };

/**
 * Columns from an imported file, kept next to the results ("in_" + column name).
 * params.input_rows = { "<value as in the list>": { "Column": "value", … } }
 */
function inColumns(row: Rec | null | undefined): Rec {
  if (!row) return {};
  const out: Rec = {};
  for (const [k, v] of Object.entries(row)) if (v !== "" && v != null) out["in_" + k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] = v;
  return out;
}

/**
 * A list step's input: the rows of an imported file (params.upload_id, stored in the
 * database) plus anything typed in the box. extra(value) gives that row's file columns.
 */
async function loadList(params: Rec, max: number): Promise<{ values: string[]; extra: (value: string) => Rec }> {
  const fromUpload = params.upload_id ? await uploadRows(String(params.upload_id), max) : [];
  const seen = new Set<string>();
  const values: string[] = [];
  const extras = new Map<string, Rec>();
  for (const r of fromUpload) {
    if (seen.has(r.value)) continue;
    seen.add(r.value);
    values.push(r.value);
    if (r.extra) extras.set(r.value, r.extra);
  }
  for (const t of lines(params)) if (!seen.has(t)) { seen.add(t); values.push(t); }
  const legacy = params.input_rows as Record<string, Rec> | undefined; // older jobs kept file columns in the step settings
  return { values: values.slice(0, Number.isFinite(max) ? max : undefined), extra: (v) => inColumns(extras.get(v) ?? legacy?.[v]) };
}

// ── the catalog ──────────────────────────────────────────────────────────────
export const STEPS: StepDef[] = [
  // ─── Sources ───
  {
    id: "people_search", label: "Find People", endpoint: "POST /v2/search/people", group: "source",
    help: "People matching company + person filters across all companies. Fastest way to a lead list.",
    gives: ["person", "company"], dedupeOn: "person",
    schemaPath: "/v2/search/people", omit: ["cursor", "max_results"], split: PEOPLE_SPLITS,
    async *source(params, ctx) {
      for await (const p of cursorPaged((q) => ctx.client.search.people(q as any), params, ctx)) yield personItem(p);
    },
  },
  {
    id: "company_search", label: "Company Search", endpoint: "POST /v2/search/companies", group: "source",
    help: "Companies matching firmographic filters (industry, size, HQ, funding, tech, traffic…).",
    gives: ["company"], dedupeOn: "company",
    schemaPath: "/v2/search/companies", omit: ["cursor", "max_results"], split: COMPANY_SPLITS,
    async *source(params, ctx) {
      for await (const c of cursorPaged((q) => ctx.client.search.companies(q as any), params, ctx)) yield { company: companyRec(c), extra: {} };
    },
  },
  {
    id: "tam_by_jobs", label: "TAM by Jobs (hiring companies)", endpoint: "POST /v2/company/tam-by-jobs", group: "source",
    help: "Companies currently hiring for the roles you describe. A hiring signal.",
    gives: ["company"], dedupeOn: "company",
    schemaPath: "/v2/company/tam-by-jobs", omit: ["cursor", "max_results"], split: JOB_SPLITS,
    async *source(params, ctx) {
      for await (const r of cursorPaged((q) => ctx.client.company.tam_by_jobs(q as any), params, ctx))
        yield { company: companyRec(r.company), extra: { matched_jobs: r.matched_jobs } };
    },
  },
  {
    id: "tam_by_people", label: "TAM by People (companies by persona)", endpoint: "POST /v2/company/tam-by-people", group: "source",
    help: "Companies where people matching your persona filters work.",
    gives: ["company"], dedupeOn: "company",
    schemaPath: "/v2/company/tam-by-people", omit: ["cursor", "max_results"], split: PEOPLE_SPLITS,
    async *source(params, ctx) {
      for await (const r of cursorPaged((q) => ctx.client.company.tam_by_people(q as any), params, ctx))
        yield { company: companyRec(r.company), extra: { matched_people: r.matched_people } };
    },
  },
  {
    id: "jobs_search", label: "Search Jobs", endpoint: "POST /v2/jobs/search", group: "source",
    help: "Live job postings across companies. Duplicate check keeps one row per hiring company.",
    gives: ["job", "company"], dedupeOn: "company",
    schemaPath: "/v2/jobs/search", omit: ["cursor", "max_results"], split: JOB_SPLITS,
    async *source(params, ctx) {
      for await (const j of cursorPaged((q) => ctx.client.jobs.search(q as any), params, ctx))
        yield { job: jobRec(j), company: { company_name: j.company_name, company_linkedin_url: j.company_linkedin_url }, extra: {} };
    },
  },
  {
    id: "list_domains", label: "List: companies (domains or LinkedIn URLs)", endpoint: "POST /v2/enrichment/domain-to-linkedin", group: "source",
    help: "Your own list of companies: websites (stripe.com…) and/or LinkedIn company pages. LinkedIn URLs are used directly (free); each domain is converted to its LinkedIn page (1 record when found).",
    gives: ["company"], dedupeOn: "company", extraParams: LIST_SCHEMA, listInput: { placeholder: "stripe.com\nhttps://www.linkedin.com/company/notion" },
    async *source(params, ctx) {
      const L = await loadList(params, ctx.maxItems);
      const picked = L.values;
      // LinkedIn company pages need no lookup.
      for (const url of picked.filter((l) => /linkedin\.com\/(company|school|showcase)\//i.test(l))) {
        yield { company: { company_linkedin_url: url }, extra: L.extra(url) };
      }
      const domains = picked.filter((l) => !/linkedin\.com\//i.test(l)).map((d) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""));
      yield* mapConcurrent(domains, ctx, async (domain) => {
        const r: AnyObj = await ctx.client.enrichment.domain_to_linkedin({ domain });
        ctx.charge(r);
        if (!r.found) { ctx.log(`${domain}: no LinkedIn page found`); return undefined; }
        ctx.hit();
        return { company: { company_name: r.company_name, company_domain: domain, company_linkedin_url: r.company_linkedin_url }, extra: L.extra(domain) };
      });
    },
  },
  {
    id: "list_company_urls", label: "List: LinkedIn company URLs", endpoint: "(no API call)", group: "source",
    help: "Your own list of LinkedIn company pages. Free. Add Company Enrichment to fill in details.",
    gives: ["company"], dedupeOn: "company", extraParams: LIST_SCHEMA, listInput: { placeholder: "https://www.linkedin.com/company/stripe" },
    async *source(params, ctx) {
      const L = await loadList(params, ctx.maxItems);
      for (const url of L.values) yield { company: { company_linkedin_url: url }, extra: L.extra(url) };
    },
  },
  {
    id: "list_person_urls", label: "List: LinkedIn profile URLs", endpoint: "(no API call)", group: "source",
    help: "Your own list of LinkedIn profiles. Free. Add Person Enrichment for names, titles, companies.",
    gives: ["person"], dedupeOn: "person", extraParams: LIST_SCHEMA, listInput: { placeholder: "https://www.linkedin.com/in/someone" },
    async *source(params, ctx) {
      const L = await loadList(params, ctx.maxItems);
      for (const url of L.values) yield { person: { person_linkedin_url: url }, extra: L.extra(url) };
    },
  },
  {
    id: "list_emails", label: "List: work emails (reverse lookup)", endpoint: "POST /v2/enrichment/email-to-person", group: "source",
    help: "Work emails, e.g. inbound signups. Finds the person + company behind each.",
    gives: ["person", "company"], dedupeOn: "person", extraParams: LIST_SCHEMA, listInput: { placeholder: "jane@acme.com" },
    async *source(params, ctx) {
      const L = await loadList(params, ctx.maxItems);
      yield* mapConcurrent(L.values, ctx, async (email) => {
        const r: AnyObj = await ctx.client.enrichment.email_to_person({ email });
        ctx.charge(r);
        if (!r.found) { ctx.log(`${email}: no person found`); return undefined; }
        ctx.hit();
        const item = personItem(r.person);
        item.person!.email = email;
        Object.assign(item.extra, L.extra(email));
        return item;
      });
    },
  },
  {
    id: "list_phones", label: "List: phone numbers (reverse lookup)", endpoint: "POST /v2/enrichment/phone-to-person", group: "source",
    help: "US phone numbers. Finds the person + company behind each.",
    gives: ["person", "company"], dedupeOn: "person", extraParams: LIST_SCHEMA, listInput: { placeholder: "+14155550123" },
    async *source(params, ctx) {
      const L = await loadList(params, ctx.maxItems);
      yield* mapConcurrent(L.values, ctx, async (phone) => {
        const r: AnyObj = await ctx.client.enrichment.phone_to_person({ phone });
        ctx.charge(r);
        if (!r.found) { ctx.log(`${phone}: no person found`); return undefined; }
        ctx.hit();
        const item = personItem(r.person);
        item.person!.phone = phone;
        Object.assign(item.extra, L.extra(phone));
        return item;
      });
    },
  },

  // ─── Company → people / jobs ───
  {
    id: "waterfall_icp", label: "Waterfall ICP (best people per company)", endpoint: "POST /v2/search/waterfall-icp-keyword", group: "expand",
    help: "For each company, finds people by title tiers in priority order (tier 1 first, then tier 2…).",
    needs: "company", gives: ["person"], dedupeOn: "person",
    schemaPath: "/v2/search/waterfall-icp-keyword", omit: ["company_linkedin_url"],
    async *expand(item, params, ctx) {
      const r: AnyObj = await ctx.client.search.waterfall_icp({ ...(params as any), company_linkedin_url: companyUrl(item) });
      ctx.charge(r);
      for (const m of r.results ?? []) {
        ctx.hit();
        const child = personItem(m.person, item);
        child.extra.icp_tier = m.icp;
        yield child;
      }
    },
  },
  {
    id: "employee_finder", label: "Employee Finder", endpoint: "POST /v2/search/employee-finder", group: "expand",
    help: "For each company, lists employees by level, department and location.",
    needs: "company", gives: ["person"], dedupeOn: "person",
    schemaPath: "/v2/search/employee-finder", omit: ["company_linkedin_url", "page"],
    async *expand(item, params, ctx) {
      const page: AnyObj = await ctx.client.search.employee_finder({ ...(params as any), company_linkedin_url: companyUrl(item) });
      ctx.charge(page.response);
      for (const p of page.data) { ctx.hit(); yield personItem(p, item); }
    },
  },
  {
    id: "company_jobs", label: "Company Jobs", endpoint: "POST /v2/jobs/company", group: "expand",
    help: "For each company, its live job postings (one row per job).",
    needs: "company", gives: ["job"], dedupeOn: "job",
    schemaPath: "/v2/jobs/company", omit: ["company_linkedin_url", "cursor"],
    async *expand(item, params, ctx) {
      const page: AnyObj = await ctx.client.jobs.company({ ...(params as any), company_linkedin_url: companyUrl(item) });
      ctx.charge(page.response);
      for (const j of page.data) { ctx.hit(); yield { ...item, job: jobRec(j), extra: { ...item.extra } }; }
    },
  },

  // ─── Company enrichment ───
  {
    id: "company_enrichment", label: "Company Enrichment", endpoint: "POST /v2/enrichment/company", group: "enrich",
    help: "Full company profile: industry, size, HQ, website, revenue range…",
    needs: "company", gives: [],
    async enrich(item, _p, ctx) {
      const r: AnyObj = await ctx.client.enrichment.company({ company_linkedin_url: companyUrl(item) });
      ctx.charge(r);
      if (r.found) { ctx.hit(); item.company = { ...item.company, ...stripEmpty(companyRec(r.company)) }; }
    },
  },
  {
    id: "linkedin_to_domain", label: "LinkedIn → Email Domain", endpoint: "POST /v2/enrichment/linkedin-to-domain", group: "enrich",
    help: "The domain the company uses for email (can differ from its website).",
    needs: "company", gives: [],
    async enrich(item, _p, ctx) {
      const r: AnyObj = await ctx.client.enrichment.linkedin_to_domain({ company_linkedin_url: companyUrl(item) });
      ctx.charge(r);
      if (r.found) { ctx.hit(); item.company!.company_email_domain = r.email_domain; }
    },
  },
  {
    id: "dist_country", label: "Employees by Country", endpoint: "POST /v2/enrichment/company-distribution-by-country", group: "enrich",
    help: "Where the company's employees are: top 5 countries with percentages.",
    needs: "company", gives: [],
    schemaPath: "/v2/enrichment/company-distribution-by-country", omit: ["company_linkedin_url"],
    async enrich(item, params, ctx) {
      const r: AnyObj = await ctx.client.enrichment.company_distribution_by_country({ ...(params as any), company_linkedin_url: companyUrl(item) });
      ctx.charge(r);
      if (r.found) {
        ctx.hit();
        item.extra.total_employees = r.total_employees;
        item.extra.top_countries = (r.distribution ?? []).slice(0, 5).map((d: AnyObj) => `${d.country} ${d.percentage_ratio}%`).join(", ");
      }
    },
  },
  {
    id: "dist_department", label: "Employees by Department", endpoint: "POST /v2/enrichment/company-distribution-by-department", group: "enrich",
    help: "Team makeup: top 5 departments with percentages.",
    needs: "company", gives: [],
    schemaPath: "/v2/enrichment/company-distribution-by-department", omit: ["company_linkedin_url"],
    async enrich(item, params, ctx) {
      const r: AnyObj = await ctx.client.enrichment.company_distribution_by_department({ ...(params as any), company_linkedin_url: companyUrl(item) });
      ctx.charge(r);
      if (r.found) {
        ctx.hit();
        item.extra.total_employees = r.total_employees;
        item.extra.top_departments = (r.distribution ?? []).slice(0, 5).map((d: AnyObj) => `${d.department} ${d.percentage_ratio}%`).join(", ");
      }
    },
  },

  // ─── Person enrichment ───
  {
    id: "person_enrichment", label: "Person Enrichment", endpoint: "POST /v2/enrichment/person", group: "enrich",
    help: "Full profile from a LinkedIn URL: name, title, location, current company.",
    needs: "person", gives: ["company"],
    async enrich(item, _p, ctx) {
      const r: AnyObj = await ctx.client.enrichment.person({ person_linkedin_url: personUrl(item) });
      ctx.charge(r);
      if (!r.found) return;
      ctx.hit();
      const full = personItem(r.person);
      item.person = { ...item.person, ...stripEmpty(full.person!) };
      item.company = { ...full.company, ...item.company };
    },
  },
  {
    id: "find_email", label: "Find Work Email", endpoint: "POST /v2/enrichment/email", group: "enrich",
    help: "Verified work email. Only charged when found.",
    needs: "person", gives: [],
    async enrich(item, _p, ctx) {
      const r: AnyObj = await ctx.client.enrichment.email({ person_linkedin_url: personUrl(item) });
      ctx.charge(r);
      if (r.found) { ctx.hit(); item.person!.email = r.email; }
      item.person!.email_status = r.found ? "found" : "not_found";
    },
  },
  {
    id: "find_phone", label: "Find Mobile / Direct Phone", endpoint: "POST /v2/enrichment/phone", group: "enrich",
    help: "Mobile or direct phone. Coverage is US only. Only charged when found.",
    needs: "person", gives: [],
    extraParams: { us_only: { type: "boolean", default: true, description: "Only look up people located in the US (others are never found)" } },
    async enrich(item, params, ctx) {
      const usOnly = params.us_only !== false;
      if (usOnly && String(item.person?.country ?? "").toUpperCase() !== "US") {
        item.person!.phone_status = "skipped_non_us";
        return;
      }
      const r: AnyObj = await ctx.client.enrichment.phone({ person_linkedin_url: personUrl(item) });
      ctx.charge(r);
      if (r.found) { ctx.hit(); item.person!.phone = r.phone; }
      item.person!.phone_status = r.found ? "found" : "not_found";
    },
  },

  // ─── NEW: Re-check saved people (job-change tracker source) ───
  {
    id: "saved_people", label: "Re-check saved people (from my database)", endpoint: "(your database, no API call)", group: "source",
    help: "Loads people you already saved, with the company they were at when saved. Pair with Job Change Check.",
    gives: ["person", "company"], dedupeOn: "person", noHistorySkip: true,
    extraParams: {
      run_id: { type: "string", description: "Optional: only people saved by this run ID (leave empty for everyone)" },
    },
    async *source(params, ctx) {
      const rows = await savedPeople(ctx.maxItems, (params.run_id as string) || undefined);
      ctx.log(`Loaded ${rows.length} saved people`);
      for (const r of rows) {
        const company: Rec = {}, person: Rec = {};
        for (const [k, v] of Object.entries(r)) {
          if (k.startsWith("company_")) company[k] = v;
          else if (PERSON_KEYS.has(k)) person[k] = v;
        }
        yield {
          person, company,
          extra: { previous_company_name: r.company_name, previous_company_linkedin_url: r.company_linkedin_url, previous_job_title: r.job_title },
        };
      }
    },
  },

  // ─── NEW: Buying committee ───
  {
    id: "buying_committee", label: "Buying Committee (3 roles per company)", endpoint: "POST /v2/search/waterfall-icp-keyword ×3", group: "expand",
    help: "For each company, finds Decision makers, Champions and Users as separate groups. Each person is tagged with their role.",
    needs: "company", gives: ["person"], dedupeOn: "person",
    extraParams: {
      decision_makers: { type: "array", items: { type: "string" }, description: "Titles, e.g. [CEO], Founder, VP Sales, CRO" },
      champions: { type: "array", items: { type: "string" }, description: "Titles, e.g. Head of Sales, Sales Director, Head of Growth" },
      users: { type: "array", items: { type: "string" }, description: "Titles, e.g. SDR, Account Executive, Sales Manager" },
      per_role: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "People per role per company" },
      country_code: { type: "array", items: { type: "string" }, description: "Only people located in these countries (e.g. US, GB)" },
    },
    async *expand(item, params, ctx) {
      const roles: [string, string[]][] = [
        ["Decision maker", (params.decision_makers as string[]) ?? ["[CEO]", "Founder", "Co-Founder", "VP Sales", "CRO", "Chief Revenue Officer"]],
        ["Champion", (params.champions as string[]) ?? ["Head of Sales", "Sales Director", "Head of Growth", "Director of Business Development"]],
        ["User", (params.users as string[]) ?? ["SDR", "BDR", "Account Executive", "Sales Manager"]],
      ];
      const countries = (params.country_code as string[]) ?? [];
      const location = countries.length ? { country_code: countries.map((c) => c.toUpperCase()) } : undefined;
      // The 3 roles are looked up at the same time.
      const results = await Promise.all(roles.filter(([, t]) => t.length).map(async ([role, titles]) => {
        const r: AnyObj = await ctx.client.search.waterfall_icp({
          company_linkedin_url: companyUrl(item),
          cascade: [{ include_title: titles, exclude_title: ["intern", "assistant"], ...(location ? { location } : {}) }],
          max_results: Number(params.per_role ?? 1),
        } as any);
        ctx.charge(r);
        return { role, found: (r.results ?? []) as AnyObj[] };
      }));
      for (const { role, found } of results) {
        for (const m of found) {
          ctx.hit();
          const child = personItem(m.person, item);
          child.extra.committee_role = role;
          yield child;
        }
      }
    },
  },

  // ─── NEW: Job change check ───
  {
    id: "job_change_check", label: "Job Change Check", endpoint: "POST /v2/enrichment/person", group: "enrich",
    noCache: true, // a cached profile would hide the job change
    help: "Re-reads each person's LinkedIn profile and flags whether they moved company since you saved them.",
    needs: "person", gives: ["company"],
    extraParams: { only_changed: { type: "boolean", default: false, description: "Keep only people who changed company" } },
    async enrich(item, params, ctx) {
      const before = String(item.extra.previous_company_linkedin_url ?? item.company?.company_linkedin_url ?? "");
      const beforeName = item.extra.previous_company_name ?? item.company?.company_name;
      const r: AnyObj = await ctx.client.enrichment.person({ person_linkedin_url: personUrl(item) });
      ctx.charge(r);
      if (!r.found) { item.extra.job_change = "profile_not_found"; return !params.only_changed; }
      const fresh = personItem(r.person);
      const after = String(fresh.company?.company_linkedin_url ?? "");
      const changed = !!before && !!after && normUrl(before) !== normUrl(after);
      item.person = { ...item.person, ...stripEmpty(fresh.person!) };
      item.company = { ...fresh.company };
      item.extra.previous_company_name = beforeName;
      item.extra.job_change = !before ? "unknown_before" : changed ? "changed" : "same";
      if (changed) ctx.hit();
      return params.only_changed ? changed : true;
    },
  },

  // ─── NEW: ICP fit check ───
  {
    id: "icp_fit", label: "ICP Fit Check", endpoint: "(no API call, free)", group: "filter",
    help: "Tags each row fit / no fit against your ideal customer, with reasons. Put Company Enrichment before it so industry and size are known.",
    needs: "company", gives: [],
    extraParams: {
      industries: { type: "array", items: { type: "string", enum: [...INDUSTRY] }, description: "Company industry must be one of these" },
      company_sizes: { type: "array", items: { type: "string", enum: [...EMPLOYEE_RANGE] }, description: "Company size must be one of these" },
      countries: { type: "array", items: { type: "string" }, description: "Company HQ (or person) country codes, e.g. US, GB" },
      title_keywords: { type: "array", items: { type: "string" }, description: "Title must contain one of these words, e.g. founder, sales" },
      exclude_title_keywords: { type: "array", items: { type: "string" }, description: "Not a fit if the title contains any of these, e.g. intern" },
      drop_non_fit: { type: "boolean", default: false, description: "Remove rows that are not a fit (otherwise kept and tagged)" },
    },
    async enrich(item, params) {
      const reasons: string[] = [];
      const c = item.company ?? {};
      const list = (k: string) => ((params[k] as string[]) ?? []).map((x) => x.toLowerCase());
      const industries = list("industries"), sizes = list("company_sizes"), countries = list("countries");
      const titleWords = list("title_keywords"), badWords = list("exclude_title_keywords");
      const title = String(item.person?.job_title ?? "").toLowerCase();

      if (industries.length && !industries.includes(String(c.company_industry ?? "").toLowerCase()))
        reasons.push(c.company_industry ? `industry: ${c.company_industry}` : "industry unknown");
      if (sizes.length && !sizes.includes(String(c.company_size ?? "").toLowerCase()))
        reasons.push(c.company_size ? `size: ${c.company_size}` : "size unknown");
      const country = String(c.company_hq_country ?? item.person?.country ?? "").toLowerCase();
      if (countries.length && !countries.includes(country)) reasons.push(country ? `country: ${country.toUpperCase()}` : "country unknown");
      if (item.person && titleWords.length && !titleWords.some((w) => title.includes(w))) reasons.push(`title: ${item.person.job_title ?? "unknown"}`);
      if (item.person && badWords.some((w) => title.includes(w))) reasons.push(`excluded title: ${item.person.job_title}`);

      item.extra.icp_fit = reasons.length ? "no_fit" : "fit";
      if (reasons.length) item.extra.icp_fit_reasons = reasons.join("; ");
      return params.drop_non_fit ? reasons.length === 0 : true;
    },
  },

  // ─── NEW: Only new since last run ───
  {
    id: "only_new", label: "Only new since last run", endpoint: "(no API call, free)", group: "filter",
    help: "Remembers what it has seen under a name you pick and only lets through companies/people it has never seen. Use the same name each time you run the same search.",
    gives: [],
    extraParams: {
      watch_name: { type: "string", description: "Memory name, e.g. sdr-hiring-us (same name = same memory)" },
      on: { type: "string", enum: ["company", "person"], description: "What counts as new (default: company)" },
    },
    async enrich(item, params, ctx) {
      const on = (params.on as Entity) || "company";
      const name = String(params.watch_name || "default").trim();
      const url = on === "person" ? item.person?.person_linkedin_url : item.company?.company_linkedin_url;
      if (!url) return true; // nothing to compare; let it through
      const isNew = await watchIsNew(`${name}:${on}`, normUrl(String(url)));
      if (isNew) ctx.hit();
      item.extra.new_since_last_run = isNew ? "yes" : "no";
      return isNew;
    },
  },

  // ─── NEW: Send to Google Sheet ───
  {
    id: "send_google_sheet", label: "Send to Google Sheet", endpoint: "(your Google Apps Script URL)", group: "send",
    help: "Appends each row to a Google Sheet the moment it's ready. One-time setup: open the setup guide.",
    docs: "/google-sheets-setup",
    gives: [], maxConcurrency: 3,
    extraParams: { apps_script_url: { type: "string", description: "Web app URL from your sheet's Apps Script (ends in /exec)" } },
    async enrich(item, params, ctx) {
      await postRow(String(params.apps_script_url ?? ""), item, {}, ctx);
    },
  },

  // ─── NEW: Send to Webhook (CRM, Zapier, Make, n8n) ───
  {
    id: "send_webhook", label: "Send to Webhook (CRM / Zapier / Make / n8n)", endpoint: "(your webhook URL)", group: "send",
    help: "POSTs each row as JSON to any URL: a Zapier/Make/n8n webhook, or your CRM's inbound webhook.",
    gives: [], maxConcurrency: 10,
    extraParams: {
      url: { type: "string", description: "Webhook URL" },
      auth_header: { type: "string", description: "Optional Authorization header value, e.g. Bearer abc123" },
    },
    async enrich(item, params, ctx) {
      const headers: Record<string, string> = {};
      if (params.auth_header) headers.Authorization = String(params.auth_header);
      await postRow(String(params.url ?? ""), item, headers, ctx);
    },
  },
];

export const STEP_BY_ID = new Map(STEPS.map((s) => [s.id, s]));

function stripEmpty(r: Rec): Rec {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

/** Not pipeline steps (no lead data): account/key-info, utils/current-date, changelog. */
export const NON_PIPELINE_ENDPOINTS = ["GET /v2/account/key-info", "POST /v2/utils/current-date", "GET /changelog"];

const PERSON_KEYS = new Set([
  "full_name", "first_name", "last_name", "job_title", "headline", "person_linkedin_url",
  "connections", "city", "state", "country", "email", "phone", "email_status", "phone_status",
]);

/** POST one finished row as JSON. Throws on failure so the step counts an error. */
async function postRow(url: string, item: Item, headers: Record<string, string>, ctx: StepCtx) {
  if (!/^https?:\/\//.test(url)) throw new Error("No valid URL set in this step's settings");
  const row = flatten(structuredClone(item));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ row }),
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  ctx.hit();
}
