import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getBatchDetail } from '@/lib/queries';
import { listTests } from '@/lib/tests/registry';
import { BatchView } from './batch-view';

export default function BatchPage({ params }: PageProps<'/batches/[id]'>) {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <Resolved params={params} />
    </Suspense>
  );
}

async function Resolved({ params }: { params: PageProps<'/batches/[id]'>['params'] }) {
  const { id } = await params;
  await connection();
  const batch = getBatchDetail(id);
  if (!batch) notFound();
  const names = Object.fromEntries((await listTests()).map((t) => [t.id, t.name]));
  return <BatchView initial={batch} testNames={names} />;
}
