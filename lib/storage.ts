// Object storage for files: background exports and imported lists.
//
//  • Cloudflare R2 (preferred): set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//    R2_BUCKET. No download (egress) fees. The browser uploads imports straight to R2
//    with a signed link, so big files never pass through the website.
//  • Supabase Storage (fallback): private bucket "exports", needs SUPABASE_SECRET_KEY.
//    The project URL comes from SUPABASE_URL, or is worked out from DATABASE_URL.
//
// Every stored file is addressed by a key like "exports/<id>/<name>.csv". Which store
// holds it is saved with the record ("r2" | "supabase"), so switching stores later
// doesn't break older links.
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";

export type Store = "r2" | "supabase";

// ── Cloudflare R2 (S3-compatible API) ───────────────────────────────────────
export const r2Enabled = () =>
  !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

let aws: AwsClient | undefined;
function r2() {
  aws ??= new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
  return aws;
}

function r2Url(key: string) {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${path}`);
}

/** A signed link for one request (GET or PUT) on `key`, valid for `seconds` (R2 allows up to 7 days). */
export async function r2SignedUrl(key: string, method: "GET" | "PUT", seconds = 3600, query: Record<string, string> = {}) {
  const url = r2Url(key);
  url.searchParams.set("X-Amz-Expires", String(Math.min(seconds, 604_800)));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const signed = await r2().sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

async function r2Fetch(key: string, method: "GET" | "HEAD" | "DELETE") {
  return r2().fetch(r2Url(key).toString(), { method });
}

// ── Supabase Storage ────────────────────────────────────────────────────────
const BUCKET = "exports";

export function projectUrl(): string | undefined {
  const explicit = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const db = process.env.DATABASE_URL ?? "";
  const ref = db.match(/postgres\.([a-z0-9]{15,})[:@]/)?.[1] ?? db.match(/db\.([a-z0-9]{15,})\.supabase\.co/)?.[1];
  return ref ? `https://${ref}.supabase.co` : undefined;
}

const supabaseEnabled = () => !!process.env.SUPABASE_SECRET_KEY && !!projectUrl();

function sbHeaders(extra: Record<string, string> = {}) {
  const key = process.env.SUPABASE_SECRET_KEY!;
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function ensureBucket() {
  const r = await fetch(`${projectUrl()}/storage/v1/bucket`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (!r.ok && r.status !== 409) {
    const text = await r.text();
    if (!/already exists|Duplicate/i.test(text)) throw new Error(`Storage bucket: HTTP ${r.status} ${text.slice(0, 200)}`);
  }
}

// ── one interface for both ──────────────────────────────────────────────────
/** Is any file store set up? */
export const storageEnabled = () => r2Enabled() || supabaseEnabled();
/** Where new files go. */
export const currentStore = (): Store => (r2Enabled() ? "r2" : "supabase");

/** Upload a local file (streamed, not read into memory). Returns its size in bytes. */
export async function uploadFile(key: string, localFile: string, contentType: string, store = currentStore()) {
  const size = statSync(localFile).size;
  const body = Readable.toWeb(createReadStream(localFile)) as ReadableStream;
  let r: Response;
  if (store === "r2") {
    r = await fetch(await r2SignedUrl(key, "PUT", 900), {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(size) },
      body,
      // @ts-expect-error Node's fetch needs this to send a stream body
      duplex: "half",
    });
  } else {
    await ensureBucket();
    r = await fetch(`${projectUrl()}/storage/v1/object/${BUCKET}/${key}`, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": contentType, "Content-Length": String(size), "x-upsert": "true" }),
      body,
      // @ts-expect-error Node's fetch needs this to send a stream body
      duplex: "half",
    });
  }
  if (!r.ok) throw new Error(`Storage upload (${store}): HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return size;
}

/** A link that downloads `key` for the next `seconds` seconds, saved as `downloadName`. */
export async function signedUrl(key: string, seconds = 3600, downloadName?: string, store: Store = "supabase"): Promise<string> {
  if (store === "r2") {
    // No spaces in the file name: a "+" for a space in a signed link is ambiguous.
    const disposition = downloadName ? { "response-content-disposition": `attachment;filename="${downloadName.replace(/[^\w.-]+/g, "_")}"` } : undefined;
    return r2SignedUrl(key, "GET", seconds, disposition);
  }
  const r = await fetch(`${projectUrl()}/storage/v1/object/sign/${BUCKET}/${key}`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!r.ok) throw new Error(`Storage link: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { signedURL } = (await r.json()) as { signedURL: string };
  const url = `${projectUrl()}/storage/v1${signedURL}`;
  return downloadName ? `${url}&download=${encodeURIComponent(downloadName)}` : url;
}

/** Size of a stored R2 object, or null when it isn't there. */
export async function r2Size(key: string): Promise<number | null> {
  const r = await r2Fetch(key, "HEAD");
  return r.ok ? Number(r.headers.get("content-length") ?? 0) : null;
}

/** Read an R2 object line by line (streamed: big files never sit in memory whole). */
export async function* r2Lines(key: string): AsyncGenerator<string> {
  const r = await r2Fetch(key, "GET");
  if (!r.ok || !r.body) throw new Error(`Storage read: HTTP ${r.status} for ${key}`);
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  rest += decoder.decode();
  if (rest.trim()) yield rest;
}

/** Delete stored files (missing ones are ignored). */
export async function deleteFiles(keys: string[], store: Store) {
  if (!keys.length) return;
  if (store === "r2") {
    if (!r2Enabled()) return;
    for (const k of keys) await r2Fetch(k, "DELETE").catch(() => undefined);
    return;
  }
  if (!supabaseEnabled()) return;
  await fetch(`${projectUrl()}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: keys }),
  }).catch(() => undefined);
}
