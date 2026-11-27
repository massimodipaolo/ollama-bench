export function StatusPill({ status }: { status: string }) {
  const cls = status === 'done' ? 'text-good' : status === 'error' ? 'text-bad' : status === 'cancelled' ? 'text-muted' : 'text-mid';
  return <span className={`text-xs font-medium uppercase ${cls}`}>{status}</span>;
}
