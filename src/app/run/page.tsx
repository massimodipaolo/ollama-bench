import { Suspense } from 'react';
import { RunForm } from './run-form';

export default function RunPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New run</h1>
        <p className="text-muted">
          Pick a test, a language and one or two models. Models run one after the other on the GPU, and judges score each answer blind.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <RunForm />
      </Suspense>
    </div>
  );
}
