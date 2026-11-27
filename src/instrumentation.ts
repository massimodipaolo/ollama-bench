/** Runs once when a Next.js server instance starts (see node_modules/next/dist/docs/.../instrumentation.md). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recoverAbandoned } = await import('@/lib/runner/recover');
  try {
    const r = await recoverAbandoned();
    if (r.sessions || r.containers)
      console.log(
        `[bench] recovered from stopped servers: ${r.sessions} session(s) marked interrupted, ${r.containers} container(s) removed`,
      );
  } catch (e) {
    console.error('[bench] recovery failed', e);
  }
}
