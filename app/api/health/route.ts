import { sql, ensureSchema } from "@/lib/pg";

export const dynamic = "force-dynamic";

/**
 * Setup check: which settings are present (never their values) and whether the
 * database answers. Open /api/health on a new deployment when something fails.
 */
export async function GET() {
  const url = process.env.DATABASE_URL ?? "";
  // Host = what follows the LAST "@" (passwords can contain "@"), so no part of the password is shown.
  const host = url.slice(url.lastIndexOf("@") + 1).match(/^([^/:?"']+)(?::(\d+))?/);
  const env = {
    DATABASE_URL: !!url,
    database_host: host ? `${host[1]}:${host[2] ?? "5432"}` : null, // host and port only, no password
    BLITZ_API_KEY: !!process.env.BLITZ_API_KEY,
    EXECUTION: process.env.EXECUTION ?? null,
    TRIGGER_SECRET_KEY: process.env.TRIGGER_SECRET_KEY ? process.env.TRIGGER_SECRET_KEY.slice(0, 7) + "…" : null, // tr_dev_ / tr_prod
    SUPABASE_SECRET_KEY: !!process.env.SUPABASE_SECRET_KEY,
    R2: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter((k) => !process.env[k]).length ? "not set (exports use Supabase Storage)" : "set",
    JOB_FILES: process.env.JOB_FILES ?? null,
    on_vercel: !!process.env.VERCEL,
  };
  const hints: string[] = [];
  if (!url) hints.push("DATABASE_URL is missing (set it for the Production environment, then redeploy).");
  if (/^["']|["']$/.test(url)) hints.push("DATABASE_URL has quotes around it: remove them in Vercel.");
  if (host && /^db\..*\.supabase\.co$/.test(host[1]) && process.env.VERCEL)
    hints.push("DATABASE_URL uses the direct db.*.supabase.co host, which Vercel often can't reach. Use the Transaction pooler string (…pooler.supabase.com:6543).");
  if (!process.env.BLITZ_API_KEY) hints.push("BLITZ_API_KEY is missing.");
  const r2Missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter((k) => !process.env[k]);
  if (r2Missing.length && r2Missing.length < 4) hints.push(`R2 is half set up: missing ${r2Missing.join(", ")}.`);
  if (process.env.EXECUTION === "trigger" && !process.env.TRIGGER_SECRET_KEY) hints.push("EXECUTION=trigger but TRIGGER_SECRET_KEY is missing.");
  if (process.env.VERCEL && !process.env.EXECUTION) hints.push("EXECUTION is not set: on Vercel set EXECUTION=worker (the VPS worker does the work).");

  let database: { ok: boolean; ms?: number; error?: string } = { ok: false };
  if (url) {
    const t = Date.now();
    try {
      await sql`select 1`;
      await ensureSchema();
      database = { ok: true, ms: Date.now() - t };
    } catch (e) {
      database = { ok: false, error: (e as Error).message };
      const m = (e as Error).message;
      if (/tenant or user not found/i.test(m)) hints.push("Pooler says 'Tenant or user not found': the user must be postgres.<project-ref> and the region in the host must match your project.");
      if (/password authentication failed/i.test(m)) hints.push("Wrong database password in DATABASE_URL (did you rotate it?).");
      if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ECONNREFUSED/i.test(m)) hints.push("Can't reach the database host: use the pooler connection string.");
    }
  }
  const ok = database.ok && hints.length === 0;
  return Response.json({ ok, database, env, hints }, { status: ok ? 200 : 500 });
}
