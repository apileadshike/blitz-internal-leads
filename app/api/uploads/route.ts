import { sql } from "@/lib/pg";
import { json } from "@/lib/http";
import { r2Enabled, r2SignedUrl } from "@/lib/storage";

/**
 * Start an upload of an imported list: { name, direct? } → { id, putUrl? }.
 * With R2 set up and `direct`, the browser PUTs the whole list to `putUrl` (one NDJSON
 * file, straight to object storage) and then calls /api/uploads/<id>/done.
 * Otherwise the rows follow in chunks to /api/uploads/<id>/rows.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { name?: string; direct?: boolean };
  const id = `up_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const key = b.direct && r2Enabled() ? `uploads/${id}.ndjson` : null;
  await sql`insert into uploads (id, name, object_key) values (${id}, ${String(b.name ?? "import").slice(0, 200)}, ${key})`;
  return json(key ? { id, putUrl: await r2SignedUrl(key, "PUT", 3600) } : { id });
}
