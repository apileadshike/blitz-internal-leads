import { filterFromQuery, leadsPage } from "@/lib/leads";
import { json } from "@/lib/http";
import { storageEnabled } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** One page of saved leads: ?q=&has_email=1&has_phone=1&country=US&job=ID&page=1&size=100 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = Math.max(1, Number(p.get("page") ?? 1) || 1);
  const size = Math.min(500, Math.max(10, Number(p.get("size") ?? 100) || 100));
  return json({ ...(await leadsPage(filterFromQuery(p), page, size)), page, size, backgroundExports: storageEnabled() });
}
