// App password: set APP_PASSWORD on any server reachable from the internet.
// The browser shows its login box; any username works.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const [scheme, b64] = (req.headers.get("authorization") ?? "").split(" ");
  let given = "";
  try { if (scheme === "Basic" && b64) given = atob(b64).split(":").slice(1).join(":"); } catch { /* bad header */ }
  if (safeEqual(given, password)) return NextResponse.next();
  return new NextResponse("Password required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Blitz Lead Engine"' } });
}

/** Constant-time compare, so the password can't be guessed by timing. */
function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
