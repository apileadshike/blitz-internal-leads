// Builds each step's settings form schema from Blitz's official OpenAPI spec,
// so every filter the API supports shows up in the UI automatically.
import { STEPS } from "./steps";
// Bundled with the code (no file read at runtime), so it works on any host, Vercel included.
import specJson from "../blitz-openapi.json";

type J = Record<string, any>;
const spec: J = specJson as J;

function deref(x: any, depth = 0): any {
  if (!x || typeof x !== "object" || depth > 20) return x;
  if (x.$ref) {
    let o: any = spec;
    for (const k of x.$ref.replace("#/", "").split("/")) o = o[k];
    return deref(o, depth + 1);
  }
  if (Array.isArray(x)) return x.map((v) => deref(v, depth + 1));
  const out: J = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === "examples" || k === "example") continue;
    if (k === "description" && typeof v === "string") { out[k] = firstSentence(v); continue; }
    out[k] = deref(v, depth + 1);
  }
  return out;
}

function firstSentence(s: string): string {
  const clean = s.replace(/<[^>]+>/g, "").replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  const m = clean.match(/^.{20,240}?[.!?](\s|$)/);
  return m ? m[0].trim() : clean.slice(0, 240);
}

/** Step catalog as sent to the browser (no functions), with form schemas. */
export function stepCatalog() {
  return STEPS.map((s) => {
    let properties: J = {};
    if (s.schemaPath) {
      const body = deref(spec.paths[s.schemaPath]?.post?.requestBody?.content?.["application/json"]?.schema) ?? {};
      properties = { ...body.properties };
      for (const k of s.omit ?? []) delete properties[k];
    }
    if (s.extraParams) properties = { ...properties, ...s.extraParams };
    return {
      id: s.id, label: s.label, endpoint: s.endpoint, group: s.group, help: s.help,
      needs: s.needs ?? null, gives: s.gives, dedupe_on: s.dedupeOn ?? null,
      list_input: s.listInput ?? null,
      docs: s.docs ?? null,
      schema: { type: "object", properties },
    };
  });
}
