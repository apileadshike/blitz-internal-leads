import { runtime } from "@/lib/runtime";
import { schedulerSettings, updateSchedulerSettings } from "@/lib/jobs";

export async function POST(req: Request) {
  await updateSchedulerSettings((await req.json().catch(() => ({}))) ?? {});
  void runtime().scheduler.tick();
  return Response.json(await schedulerSettings());
}
