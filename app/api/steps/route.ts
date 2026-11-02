import { stepCatalog } from "@/lib/schema";

let cached: ReturnType<typeof stepCatalog> | undefined;

/** Every step with its settings form schema (built from Blitz's OpenAPI spec). */
export function GET() {
  cached ??= stepCatalog();
  return Response.json(cached);
}
