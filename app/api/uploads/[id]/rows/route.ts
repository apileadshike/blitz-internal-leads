import { sql } from "@/lib/pg";
import { json } from "@/lib/http";

/**
 * Add a chunk of rows to an upload: { start, rows: [{ v: value, x?: { column: value } }] }.
 * The browser keeps each chunk well under hosting request limits (4.5 MB on Vercel).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { start?: number; rows?: { v: string; x?: Record<string, string> }[] };
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 20_000) : [];
  const start = Math.max(0, Number(b.start) || 0);
  if (!rows.length) return json({ ok: true, added: 0 });
  const [up] = await sql`select 1 from uploads where id = ${id}`;
  if (!up) return json({ error: "Upload not found" }, 404);
  await sql`
    insert into upload_rows (upload_id, idx, value, extra)
    select ${id}::text, ${start}::int + o - 1, v, nullif(x, 'null')::jsonb
    from unnest(${rows.map((r) => String(r.v))}::text[], ${rows.map((r) => JSON.stringify(r.x ?? null))}::text[]) with ordinality as t(v, x, o)
    on conflict (upload_id, idx) do nothing`;
  await sql`update uploads set rows = greatest(rows, ${start + rows.length}) where id = ${id}`;
  return json({ ok: true, added: rows.length });
}
