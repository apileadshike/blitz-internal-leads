import { sql } from "@/lib/pg";
import { json } from "@/lib/http";
import { deleteFiles, r2Size } from "@/lib/storage";

const MAX_BYTES = 500 * 1024 * 1024;

/** The browser finished putting the list in R2: { rows } → check the file is there and record it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { rows?: number };
  const [up] = await sql<{ object_key: string | null }[]>`select object_key from uploads where id = ${id}`;
  if (!up?.object_key) return json({ error: "Upload not found" }, 404);
  const size = await r2Size(up.object_key);
  if (size === null) return json({ error: "The file didn't arrive in storage. Try the import again." }, 400);
  if (size > MAX_BYTES) {
    await deleteFiles([up.object_key], "r2");
    return json({ error: "The list is too big (over 500 MB)." }, 400);
  }
  await sql`update uploads set rows = ${Math.max(0, Math.floor(Number(b.rows) || 0))} where id = ${id}`;
  return json({ ok: true, bytes: size });
}
