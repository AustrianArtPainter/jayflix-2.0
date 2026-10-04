import { NextRequest, NextResponse } from 'next/server';
import { legacyRedirect } from './lib/legacy-links';

export function middleware(request: NextRequest) {
  const target = legacyRedirect(new URL(request.url));
  return target ? NextResponse.redirect(target, 307) : NextResponse.next();
}

export const config = { matcher: ['/s=(.*)', '/index.html', '/about.html', '/watch.html', '/player.html', '/orbit-test.html'] };
