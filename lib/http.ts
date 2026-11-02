import "server-only";
import { toCsv, toXlsx } from "./export";
import type { Rec } from "./steps";

/** CSV (default) or Excel download. */
export async function rowsResponse(rows: Rec[], name: string, fmt: string | null): Promise<Response> {
  if (fmt === "xlsx") {
    return new Response(new Uint8Array(await toXlsx(rows)), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}.xlsx"`,
    } });
  }
  return new Response(toCsv(rows), { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}.csv"`,
  } });
}

export function clamp(v: unknown, dflt: number, lo: number, hi: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });
