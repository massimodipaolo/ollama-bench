import { Suspense } from 'react';
import { SessionView } from './session-view';

export default function SessionPage({ params }: PageProps<'/sessions/[id]'>) {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <Resolved params={params} />
    </Suspense>
  );
}

async function Resolved({ params }: { params: PageProps<'/sessions/[id]'>['params'] }) {
  const { id } = await params;
  return <SessionView id={id} />;
}
