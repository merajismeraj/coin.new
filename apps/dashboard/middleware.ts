import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/onboarding"];

export function middleware(req: NextRequest) {
  const isPublic = PUBLIC.some((p) => req.nextUrl.pathname.startsWith(p));
  if (!isPublic && !req.cookies.has("cn_session")) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
