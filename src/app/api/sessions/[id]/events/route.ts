import { getLive, subscribe, type SessionEvent } from '@/lib/runner/events';

/** Server-Sent Events: replays the buffered events of a live session, then streams new ones until it ends. */
export async function GET(req: Request, ctx: RouteContext<'/api/sessions/[id]/events'>) {
  const { id } = await ctx.params;
  const live = getLive(id);
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: SessionEvent | { type: 'not-live' }) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      if (!live) {
        send({ type: 'not-live' });
        controller.close();
        return;
      }
      for (const e of live.events) send(e);
      if (live.done) {
        controller.close();
        return;
      }
      const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 15_000);
      const unsub = subscribe(id, (e) => {
        try {
          send(e);
          if (e.type === 'session-end') close();
        } catch {
          close();
        }
      });
      const close = () => {
        clearInterval(ping);
        unsub?.();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
