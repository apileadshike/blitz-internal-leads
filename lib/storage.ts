// Supabase Storage (private bucket "exports"), used for big downloads made in the
// background. Needs SUPABASE_SECRET_KEY (Supabase → Project Settings → API Keys →
// secret key, server-only). The project URL comes from SUPABASE_URL, or is worked
// out from DATABASE_URL.
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

const BUCKET = "exports";

export function projectUrl(): string | undefined {
  const explicit = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const db = process.env.DATABASE_URL ?? "";
  const ref = db.match(/postgres\.([a-z0-9]{15,})[:@]/)?.[1] ?? db.match(/db\.([a-z0-9]{15,})\.supabase\.co/)?.[1];
  return ref ? `https://${ref}.supabase.co` : undefined;
}

export const storageEnabled = () => !!process.env.SUPABASE_SECRET_KEY && !!projectUrl();

function headers(extra: Record<string, string> = {}) {
  const key = process.env.SUPABASE_SECRET_KEY!;
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function ensureBucket() {
  const r = await fetch(`${projectUrl()}/storage/v1/bucket`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (!r.ok && r.status !== 409) {
    const text = await r.text();
    if (!/already exists|Duplicate/i.test(text)) throw new Error(`Storage bucket: HTTP ${r.status} ${text.slice(0, 200)}`);
  }
}

/** Upload a local file (streamed, not read into memory) to exports/<path>. */
export async function uploadFile(path: string, localFile: string, contentType: string) {
  await ensureBucket();
  const size = statSync(localFile).size;
  const r = await fetch(`${projectUrl()}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": contentType, "Content-Length": String(size), "x-upsert": "true" }),
    body: Readable.toWeb(createReadStream(localFile)) as ReadableStream,
    // @ts-expect-error Node's fetch needs this to send a stream body
    duplex: "half",
  });
  if (!r.ok) throw new Error(`Storage upload: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return size;
}

/** A link that downloads exports/<path> for the next `seconds` seconds. */
export async function signedUrl(path: string, seconds = 3600, downloadName?: string): Promise<string> {
  const r = await fetch(`${projectUrl()}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!r.ok) throw new Error(`Storage link: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { signedURL } = (await r.json()) as { signedURL: string };
  const url = `${projectUrl()}/storage/v1${signedURL}`;
  return downloadName ? `${url}&download=${encodeURIComponent(downloadName)}` : url;
}
