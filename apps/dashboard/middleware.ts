import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/onboarding"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // "/" is the storefront for visitors and the invoice list once signed in.
  const isPublic = pathname === "/" || PUBLIC.some((p) => pathname.startsWith(p));
  if (!isPublic && !req.cookies.has("cn_session")) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
