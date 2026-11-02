// File import: CSV / TSV / TXT / Excel → table → which column holds what.
// Runs in the browser, so files of any size never pass through the server
// (hosts like Vercel reject request bodies over 4.5 MB). The rows are then sent
// to the server in small chunks (see components/import-upload.ts).
import { HINTS, ORDER, kindOf, type IdType } from "./idtypes";

export type { IdType };

export type ColumnInfo = { index: number; name: string; type: IdType | null; matches: number; filled: number; sample: string[] };
export type ImportResult = {
  file: string; headers: string[]; rows: string[][]; truncated: boolean;
  columns: ColumnInfo[]; suggestion: { column: number; type: IdType } | null;
};

export const MAX_ROWS = 250_000;

// ── parsing ─────────────────────────────────────────────────────────────────
export function parseDelimited(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = ["\t", ";", ","].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) break;
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Excel: the Excel library is loaded only when an .xlsx file is imported. */
async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const mod: any = await import("exceljs");
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets.find((w: any) => w.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r: any) => {
    if (rows.length > MAX_ROWS + 1) return;
    const vals: string[] = [];
    for (let c = 1; c <= r.cellCount; c++) {
      const cell = r.getCell(c);
      const v: any = cell.value;
      vals.push(v && typeof v === "object" && "hyperlink" in v ? String(v.hyperlink ?? v.text ?? "") : String(cell.text ?? ""));
    }
    rows.push(vals);
  });
  return rows;
}

/** Read a picked file (browser File) into a table with detected columns. */
export async function readImportFile(file: File): Promise<ImportResult> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xls") throw new Error("Old .xls files aren't supported. In Excel use File → Save As → .xlsx (or .csv).");
  const table = ext === "xlsx" ? await parseXlsx(await file.arrayBuffer()) : parseDelimited(await file.text());
  return analyze(file.name, table);
}

/** Header detection + what each column holds. */
export function analyze(file: string, table: string[][]): ImportResult {
  if (!table.length) throw new Error("The file is empty.");
  const width = Math.max(...table.slice(0, 50).map((r) => r.length));
  table = table.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? "").trim()));

  // A first row with no recognisable values (and a row after it) is a header.
  const hasHeader = table.length > 1 && table[0].every((c) => !kindOf(c));
  const headers = hasHeader ? table[0].map((h, i) => h || `Column ${i + 1}`) : table[0].map((_, i) => `Column ${i + 1}`);
  let rows = hasHeader ? table.slice(1) : table;
  const truncated = rows.length > MAX_ROWS;
  rows = rows.slice(0, MAX_ROWS);

  // Classify each column from (up to) 500 sample cells.
  const columns: ColumnInfo[] = headers.map((name, index) => {
    const cells = rows.slice(0, 500).map((r) => r[index]).filter(Boolean);
    const counts = new Map<IdType, number>();
    for (const c of cells) { const k = kindOf(c); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
    let type: IdType | null = null, matches = 0;
    for (const t of ORDER) if ((counts.get(t) ?? 0) > matches) { type = t; matches = counts.get(t)!; }
    if (type && matches < Math.max(1, cells.length * 0.5)) type = null; // mostly something else
    return { index, name, type, matches, filled: cells.length, sample: cells.slice(0, 3) };
  });

  // Best column: most matches; the header name breaks ties.
  const ranked = columns.filter((c) => c.type).sort((a, b) =>
    b.matches - a.matches || Number(HINTS[b.type!].test(b.name)) - Number(HINTS[a.type!].test(a.name)));
  const best = ranked[0];
  return { file, headers, rows, truncated, columns, suggestion: best ? { column: best.index, type: best.type! } : null };
}
