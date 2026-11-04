// Checks the Cloudflare R2 setup: `npm run check:r2` (optionally: npm run check:r2 -- https://your-app.vercel.app)
// Writes a tiny test file, reads it back, checks browser uploads are allowed (CORS) and deletes it.
// Prints no secret values.
import { r2Enabled, r2SignedUrl, r2Size, deleteFiles } from "../lib/storage";

try { process.loadEnvFile?.(".env"); } catch { /* Bun loads .env itself */ }

const need = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length || !r2Enabled()) {
  console.log(`✗ Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Bucket "${process.env.R2_BUCKET}" (account …${process.env.R2_ACCOUNT_ID!.slice(-4)})`);

const key = `checks/test-${Date.now()}.txt`;
let ok = true;
const step = (good: boolean, text: string, hint = "") => {
  console.log(`${good ? "✓" : "✗"} ${text}${!good && hint ? `\n    → ${hint}` : ""}`);
  if (!good) ok = false;
  return good;
};

try {
  // 1. upload with a signed link (the same way the browser and the worker do)
  const put = await fetch(await r2SignedUrl(key, "PUT", 300), { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "hello from blitz" });
  if (step(put.ok, `Upload (HTTP ${put.status})`,
    put.status === 403 ? "Wrong keys, or the token has no Object Read & Write on this bucket." :
    put.status === 404 ? "No bucket with that name: check R2_BUCKET (exact spelling)." : await put.text())) {
    // 2. read back
    step((await r2Size(key)) === 16, "File is there");
    const get = await fetch(await r2SignedUrl(key, "GET", 300));
    step(get.ok && (await get.text()) === "hello from blitz", `Download link works (HTTP ${get.status})`);
  }

  // 3. CORS: may a browser on these sites upload straight to R2?
  const origins = ["http://localhost:4000", ...process.argv.slice(2).filter((a) => a.startsWith("http"))];
  for (const origin of origins) {
    const pre = await fetch(await r2SignedUrl(key, "PUT", 300), {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
    });
    const allowed = pre.ok && (pre.headers.get("access-control-allow-origin") === origin || pre.headers.get("access-control-allow-origin") === "*");
    step(allowed, `Browser uploads allowed from ${origin}`, "Add this address to the bucket's CORS policy (Settings → CORS policy). Imports still work without it, just slower (through the website).");
  }
} catch (e) {
  step(false, `R2 not reachable: ${(e as Error).message}`, "Check R2_ACCOUNT_ID (32 characters, from the R2 overview page).");
} finally {
  await deleteFiles([key], "r2");
}
console.log(ok ? "\nR2 is ready." : "\nFix the ✗ items above and run it again.");
process.exit(ok ? 0 : 1);
