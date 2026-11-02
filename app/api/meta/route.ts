import { runtime } from "@/lib/runtime";
import { describeError } from "@/lib/engine/common";
import { counts } from "@/lib/db";
import { NON_PIPELINE_ENDPOINTS } from "@/lib/steps";

export const dynamic = "force-dynamic";

export async function GET() {
  let account: unknown;
  try { account = await runtime().client.account.key_info(); } catch (e) { account = { error: describeError(e) }; }
  return Response.json({ account, db: await counts(), not_pipeline: NON_PIPELINE_ENDPOINTS });
}
