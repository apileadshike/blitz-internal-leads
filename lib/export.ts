import ExcelJS from "exceljs";
import { COLUMN_ORDER } from "./db";
import type { Rec } from "./steps";

/** Columns actually present in these rows, in a sensible order. */
export function columnsOf(rows: Rec[]): string[] {
  const present = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) present.add(k);
  return orderColumns(present);
}

/** Order a set of column names: imported file columns, known lead columns, the rest, then run_id/saved_at. */
export function orderColumns(present: Set<string>): string[] {
  const ordered = COLUMN_ORDER.filter((c) => present.has(c));
  // Columns from an imported file (in_…) come first, in file order, so each row still lines up with your original list.
  const fromFile = [...present].filter((c) => c.startsWith("in_"));
  const rest = [...present].filter((c) => !COLUMN_ORDER.includes(c) && !c.startsWith("in_")).sort();
  // keep run_id/saved_at last
  return [...fromFile, ...ordered.filter((c) => c !== "run_id" && c !== "saved_at"), ...rest, ...ordered.filter((c) => c === "run_id" || c === "saved_at")];
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Rec[]): string {
  const cols = columnsOf(rows);
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export async function toXlsx(rows: Rec[]): Promise<Buffer> {
  const cols = columnsOf(rows);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leads");
  ws.columns = cols.map((c) => ({ header: c, key: c, width: /url|headline|summary|top_/.test(c) ? 40 : 20 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
