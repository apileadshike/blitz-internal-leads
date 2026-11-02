// Provider cache: the answer to every single-input lookup (email, phone, company,
// person, domain ↔ LinkedIn, reverse lookups) is kept in Postgres for a while, so
// the same lookup is never paid for twice. Searches are not cached (results change).
//
// Each run can turn it off ("fresh data"), and steps that exist to detect changes
// (the job-change check) always skip it.
import { createHash } from "node:crypto";
import type { BlitzAPI } from "blitz-api-js";
import { sql } from "../pg";

/** Days an answer stays valid: [found, not found]. Not-found answers are free but slow, so they're kept briefly. */
export const CACHE_DAYS: Record<string, [number, number]> = {
  email: [90, 14],
  phone: [90, 14],
  domain_to_linkedin: [180, 30],
  linkedin_to_domain: [180, 30],
  email_to_person: [90, 14],
  phone_to_person: [90, 14],
  company: [30, 14],
  person: [30, 14],
  company_distribution_by_country: [30, 14],
  company_distribution_by_department: [30, 14],
};

export const cacheEnabled = () => process.env.CACHE !== "off";

/** Same input, same key: lower-case, trimmed, no trailing slashes, keys sorted. */
function keyOf(method: string, args: unknown): string {
  const norm = (v: any): any =>
    typeof v === "string" ? v.trim().toLowerCase().replace(/\/+$/, "")
    : Array.isArray(v) ? v.map(norm)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    : v;
  return createHash("sha256").update(method + "\n" + JSON.stringify(norm(args))).digest("hex");
}

// ── batched reads and writes (one query for everything asked in the same few ms) ──
type Pending<T> = { key: string; method: string; resolve: (v: T) => void; reject: (e: unknown) => void };
let reads: Pending<any>[] = [];
let readTimer: NodeJS.Timeout | undefined;
function flushReads() {
  readTimer = undefined;
  const batch = reads;
  reads = [];
  if (!batch.length) return;
  sql<{ provider: string; key: string; response: any }[]>`
    select provider, key, response from provider_cache
    where key = any(${batch.map((b) => b.key)}::text[]) and expires_at > now()`
    .then((found) => {
      const map = new Map(found.map((f) => [f.provider + ":" + f.key, f.response]));
      for (const b of batch) b.resolve(map.get(b.method + ":" + b.key));
    })
    .catch((e) => batch.forEach((b) => b.resolve(undefined))); // cache trouble never blocks the lookup
}
function cacheGet(method: string, key: string): Promise<any | undefined> {
  return new Promise((resolve, reject) => {
    reads.push({ key, method, resolve, reject });
    if (reads.length >= 200) flushReads();
    else readTimer ??= setTimeout(flushReads, 10);
  });
}

let writes: { method: string; key: string; response: string; found: boolean; days: number }[] = [];
let writeTimer: NodeJS.Timeout | undefined;
function flushWrites() {
  writeTimer = undefined;
  const batch = writes;
  writes = [];
  if (!batch.length) return;
  void sql`
    insert into provider_cache (provider, key, response, found, expires_at)
    select p, k, r::jsonb, f, now() + make_interval(days => d)
    from unnest(${batch.map((b) => b.method)}::text[], ${batch.map((b) => b.key)}::text[], ${batch.map((b) => b.response)}::text[],
                ${batch.map((b) => b.found)}::bool[], ${batch.map((b) => b.days)}::int[]) as t(p, k, r, f, d)
    on conflict (provider, key) do update set response = excluded.response, found = excluded.found,
      fetched_at = now(), expires_at = excluded.expires_at`
    .catch((e) => console.error("[cache] write failed:", e.message));
}
function cachePut(method: string, key: string, response: any) {
  const found = response?.found !== false;
  const days = CACHE_DAYS[method][found ? 0 : 1];
  writes.push({ method, key, response: JSON.stringify(response), found, days });
  if (writes.length >= 200) flushWrites();
  else writeTimer ??= setTimeout(flushWrites, 200);
}

/**
 * A client whose enrichment lookups go through the cache. Cached answers come back
 * with records_used = 0 (nothing was charged), and `counter.hits` counts them.
 */
export function cachedClient(client: BlitzAPI, counter: { hits: number }): BlitzAPI {
  const enrichment = new Proxy(client.enrichment as any, {
    get(target, prop: string) {
      const fn = target[prop];
      if (typeof fn !== "function") return fn;
      if (!(prop in CACHE_DAYS)) return fn.bind(target);
      return async (args: unknown, ...rest: unknown[]) => {
        const key = keyOf(prop, args);
        const hit = await cacheGet(prop, key);
        if (hit !== undefined) {
          counter.hits++;
          return { ...hit, fair_usage: { ...(hit.fair_usage ?? {}), records_used: 0 }, from_cache: true };
        }
        const res = await fn.call(target, args, ...rest);
        cachePut(prop, key, res);
        return res;
      };
    },
  });
  return new Proxy(client as any, {
    get(target, prop: string) {
      if (prop === "enrichment") return enrichment;
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as BlitzAPI;
}

/** Drop answers past their expiry (called by the reaper). */
export async function pruneCache() {
  await sql`delete from provider_cache where expires_at < now()`;
}
