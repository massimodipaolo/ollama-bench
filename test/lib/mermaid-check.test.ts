// The real Mermaid parser, server-side (no browser): the analysis the Mermaid checks score.
import { describe, expect, it } from 'vitest';
import { analyzeMermaid } from '@/lib/mermaid-check';

const block = (src: string) => '```mermaid\n' + src + '\n```';

describe('analyzeMermaid', () => {
  it('reads the structure of a flowchart: nodes, decisions, subgraphs, labelled edges, loops', async () => {
    const a = await analyzeMermaid(
      block(`flowchart TD
  subgraph Intake
    A[Request received] --> B{Valid?}
  end
  subgraph Refund
    C[Refund] --> D{Paid?}
  end
  B -->|yes| C
  B -->|no| E[Reject]
  D -->|no| R[Retry payment] --> D
  D -->|yes| F[Done]`),
    );
    expect(a).toMatchObject({ blocks: 1, extraText: false, valid: true, decisions: 2, subgraphs: 2, hasCycle: true });
    expect(a.diagramType).toMatch(/^flowchart/);
    expect(a.nodes).toBe(7);
    expect(a.labelledEdges).toBe(4);
    expect(a.subgraphTitles).toEqual(['Intake', 'Refund']);
    expect(a.labels).toContain('Retry payment');
    expect(a.edgeLabels).toEqual(expect.arrayContaining(['yes', 'no']));
  });

  it('flags text outside the block and counts blocks', async () => {
    const a = await analyzeMermaid(`Here it is:\n${block('flowchart LR\n  A --> B')}\n${block('flowchart LR\n  C --> D')}`);
    expect(a.extraText).toBe(true);
    expect(a.blocks).toBe(2);
    expect(a.hasCycle).toBe(false);
  });

  it('reports a parse error, with the parser message', async () => {
    const a = await analyzeMermaid(block('flowchart TD\n  A[unclosed --> B'));
    expect(a.valid).toBe(false);
    expect(a.error).toMatch(/parse error|expecting/i);
  });

  it('no mermaid block at all', async () => {
    expect(await analyzeMermaid('just text')).toMatchObject({ blocks: 0, valid: false, error: 'no ```mermaid code block' });
  });

  it('other diagram types are valid, without flowchart structure', async () => {
    const a = await analyzeMermaid(block('sequenceDiagram\n  Alice->>Bob: Hello'));
    expect(a.valid).toBe(true);
    expect(a.diagramType).toBe('sequence');
    expect(a.nodes).toBeUndefined();
  });
});
