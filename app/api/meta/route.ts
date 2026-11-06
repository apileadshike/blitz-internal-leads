import { runtime } from "@/lib/runtime";
import { describeError } from "@/lib/engine/common";
import { counts } from "@/lib/db";
import { NON_PIPELINE_ENDPOINTS } from "@/lib/steps";

export const dynamic = "force-dynamic";

export async function GET() {
  // Both at the same time; neither can fail the request (the builder needs this to open).
  const [account, db] = await Promise.all([
    Promise.resolve().then(() => runtime().client.account.key_info()).catch((e) => ({ error: describeError(e) })),
    counts(),
  ]);
  return Response.json({ account, db, not_pipeline: NON_PIPELINE_ENDPOINTS });
}
