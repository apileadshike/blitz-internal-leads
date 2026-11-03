// Send an imported list to the server. Returns the upload id that a list step reads
// from (params.upload_id).
//  • With Cloudflare R2 set up: the whole list goes straight from the browser to R2 in
//    one request (a signed link), never through the website.
//  • Otherwise (or if that fails): in chunks to the website, each well under hosting
//    request limits (Vercel rejects bodies over 4.5 MB).
const CHUNK_ROWS = 5000;
const CHUNK_BYTES = 2_500_000;

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Upload failed (HTTP ${r.status})`);
  return j;
}

/** PUT a file to a signed storage link, reporting progress (fetch can't report upload progress). */
function put(url: string, body: Blob, onProgress?: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/x-ndjson");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage upload failed (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Storage upload failed (network or CORS: see README → Cloudflare R2)"));
    xhr.send(body);
  });
}

export async function uploadList(
  name: string,
  values: string[],
  extra: Record<string, Record<string, string>> | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  // Straight to object storage when the server offers a signed link.
  const direct = await post("/api/uploads", { name, direct: true });
  if (direct.putUrl) {
    try {
      const lines = values.map((v) => JSON.stringify({ v, ...(extra?.[v] ? { x: extra[v] } : {}) }));
      const blob = new Blob([lines.join("\n")], { type: "application/x-ndjson" });
      onProgress?.(0, values.length);
      await put(direct.putUrl, blob, (f) => onProgress?.(Math.floor(f * values.length), values.length));
      await post(`/api/uploads/${direct.id}/done`, { rows: values.length });
      onProgress?.(values.length, values.length);
      return direct.id;
    } catch (e) {
      console.warn("Direct upload to storage failed, sending through the website instead:", e);
    }
  }
  const { id } = direct.putUrl ? await post("/api/uploads", { name }) : direct;
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
