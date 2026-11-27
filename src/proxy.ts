import { NextResponse, type NextRequest } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// API and page responses must not be reachable through a non-loopback host.
export function proxy(request: NextRequest) {
  const host = request.headers.get('host');
  let requestUrl: URL;
  try {
    requestUrl = new URL(`${request.nextUrl.protocol}//${host}`);
  } catch {
    return NextResponse.json({ error: 'Invalid request host' }, { status: 403 });
  }

  if (!LOCAL_HOSTS.has(requestUrl.hostname)) {
    return NextResponse.json({ error: 'This app is available only on the local machine' }, { status: 403 });
  }

  if (!request.nextUrl.pathname.startsWith('/api/')) return NextResponse.next();

  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== requestUrl.origin) {
        return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
    }
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (request.method !== 'GET' && request.method !== 'HEAD' && contentType && contentType !== 'application/json') {
    return NextResponse.json({ error: 'Expected application/json' }, { status: 415 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/:path*',
};
