import { sql } from "@/lib/pg";
import { json } from "@/lib/http";

/** Start an upload of an imported list: { name } → { id }. Rows follow in chunks. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { name?: string };
  const id = `up_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await sql`insert into uploads (id, name) values (${id}, ${String(b.name ?? "import").slice(0, 200)})`;
  return json({ id });
}
