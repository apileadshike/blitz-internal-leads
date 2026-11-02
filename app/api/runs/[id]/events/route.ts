import { pollRun } from "@/lib/engine/runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How long one connection stays open. Serverless hosts cut requests after a limit, so we end first and the page reconnects. */
const WINDOW_MS = 40_000;

/**
 * Live progress (Server-Sent Events), read from Postgres every second.
 * ?log=<id>&row=<id> continues after the last log/row the page already has, so a
 * reconnect never repeats anything. Every poll sends a "cursor" event with the
 * position; when the window ends the stream closes and the page reconnects with it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const since = { log: Number(q.get("log") ?? 0) || 0, row: Number(q.get("row") ?? 0) || 0 };
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => { closed = true; });
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      const until = Date.now() + WINDOW_MS;
      try {
        while (!closed) {
          const { events, finished } = await pollRun(id, since);
          for (const ev of events) send(ev);
          send({ type: "cursor", log: since.log, row: since.row });
          if (finished) break;
          if (Date.now() > until) { send({ type: "reconnect" }); break; }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (e) {
        send({ type: "reconnect", reason: (e as Error).message });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
