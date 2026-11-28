// Security regression tests for the request guard (src/proxy.ts): the app is local-only and has no authentication,
// so this is what keeps other hosts and other sites from driving it.
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '@/proxy';

function request(path: string, init: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}) {
  const host = init.host ?? 'localhost:3000';
  return new NextRequest(`http://${host}${path}`, {
    method: init.method ?? 'GET',
    headers: { host, ...init.headers },
    body: init.body,
  });
}

/** NextResponse.next() lets the request through; anything else is a refusal. */
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('host check: loopback names only', () => {
  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'localhost'])('allows %s', (host) => {
    expect(passes(proxy(request('/', { host })))).toBe(true);
  });

  it.each(['evil.example', '192.168.1.20:3000', 'localhost.evil.example', '0.0.0.0:3000'])('refuses %s (403)', async (host) => {
    const res = proxy(request('/', { host }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This app is available only on the local machine' });
  });

  it('a spoofed Host header wins over the URL (DNS rebinding)', () => {
    const req = new NextRequest('http://localhost:3000/api/tests', { headers: { host: 'attacker.example' } });
    expect(proxy(req).status).toBe(403);
  });
});

describe('API writes: same origin only', () => {
  const post = (headers: Record<string, string>) =>
    proxy(request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }));

  it('allows a same-origin JSON POST', () => {
    expect(passes(post({ origin: 'http://localhost:3000' }))).toBe(true);
    expect(passes(post({}))).toBe(true); // no Origin: a non-browser client (pnpm bench)
  });

  it('refuses another origin, or a cross-site fetch', () => {
    expect(post({ origin: 'http://evil.example' }).status).toBe(403);
    expect(post({ origin: 'http://localhost:3001' }).status).toBe(403); // another local app
    expect(post({ 'sec-fetch-site': 'cross-site' }).status).toBe(403);
    expect(post({ origin: 'not a url' }).status).toBe(403);
  });

  it('refuses a non-JSON body (an HTML form can send text/plain cross-site without a preflight)', () => {
    const res = proxy(request('/api/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
    expect(res.status).toBe(415);
  });

  it('pages are not origin-checked; GET needs no content type', () => {
    expect(passes(proxy(request('/run', { headers: { origin: 'http://evil.example' } })))).toBe(true);
    expect(passes(proxy(request('/api/tests', { headers: { 'content-type': 'text/plain' } })))).toBe(true);
  });
});
