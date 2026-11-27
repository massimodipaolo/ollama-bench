import { Suspense } from 'react';
import { RunForm } from './run-form';
import { ActiveRuns } from './active-runs';
import { HostMemory } from './host-memory';

export default function RunPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New run</h1>
        <p className="text-muted">
          Pick a test, or a capability to run all its tests as a batch, then a language and one or two models. Models run one after the
          other on the GPU, and judges score each answer blind.
        </p>
      </div>
      <ActiveRuns />
      <HostMemory />
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <RunForm />
      </Suspense>
    </div>
  );
}
