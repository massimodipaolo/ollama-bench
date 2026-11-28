'use client';

import { useEffect, useId, useState } from 'react';
import { useResolvedTheme } from '@/lib/theme';

/**
 * A ```mermaid block rendered as SVG. Mermaid is large, so it is loaded only when a diagram is on screen.
 * securityLevel "strict" sanitizes labels and disables click handlers (model output is untrusted).
 * Invalid source (e.g. a diagram still streaming) shows the code with the parser's message.
 */
export function MermaidDiagram({ chart }: { chart: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the theme shown (the header's switch, or the system's): the SVG is redrawn when it changes
  const theme = useResolvedTheme();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default' });
        const { svg } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSvg(null);
          setError((e as Error).message?.split('\n')[0] ?? 'Invalid diagram');
        }
        // mermaid leaves an error placeholder in <body> on failed renders
        document.getElementById(`d${id}`)?.remove();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id, theme]);

  if (svg) return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <div>
      <pre>
        <code>{chart}</code>
      </pre>
      {error && <p className="text-[11px] text-mid">Mermaid: {error}</p>}
    </div>
  );
}
