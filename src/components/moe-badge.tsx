/** "MoE" tag for mixture-of-experts models (same look as the provider/baseline tags), details on hover. */
export function MoeBadge({
  experts,
  active,
  className = 'ml-2',
}: {
  experts: number | null | undefined;
  active?: number | null;
  className?: string;
}) {
  if (!experts) return null;
  const detail = `Mixture of experts: ${experts} experts${active ? `, ${active} active per token` : ''}`;
  return (
    <span className={`${className} rounded bg-accent/15 px-1.5 text-xs text-accent`} title={detail} aria-label={detail}>
      MoE
    </span>
  );
}
