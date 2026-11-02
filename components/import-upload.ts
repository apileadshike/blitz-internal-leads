// Send an imported list to the server in chunks (each well under hosting request
// limits: Vercel rejects bodies over 4.5 MB). Returns the upload id that a list
// step reads from (params.upload_id).
const CHUNK_ROWS = 5000;
const CHUNK_BYTES = 2_500_000;

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Upload failed (HTTP ${r.status})`);
  return j;
}

export async function uploadList(
  name: string,
  values: string[],
  extra: Record<string, Record<string, string>> | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const { id } = await post("/api/uploads", { name });
  let start = 0;
  onProgress?.(0, values.length);
  while (start < values.length) {
    const rows: { v: string; x?: Record<string, string> }[] = [];
    let bytes = 0;
    for (let i = start; i < values.length && rows.length < CHUNK_ROWS; i++) {
      const row = { v: values[i], ...(extra?.[values[i]] ? { x: extra[values[i]] } : {}) };
      const size = JSON.stringify(row).length;
      if (rows.length && bytes + size > CHUNK_BYTES) break;
      rows.push(row);
      bytes += size;
    }
    await post(`/api/uploads/${id}/rows`, { start, rows });
    start += rows.length;
    onProgress?.(start, values.length);
  }
  return id;
}
