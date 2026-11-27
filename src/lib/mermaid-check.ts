/**
 * Server-side Mermaid validation for generated diagrams, with the real Mermaid parser (no rendering).
 *
 * Mermaid sanitizes labels with DOMPurify while it parses; without a browser window DOMPurify has no
 * addHook/sanitize, and valid flowcharts throw. We only parse (nothing is rendered or served), so the shared
 * DOMPurify instance gets pass-through functions. `mermaid` and `dompurify` are server externals (next.config.ts),
 * so this module and Mermaid load the same DOMPurify instance natively.
 */

export interface MermaidAnalysis {
  /** ```mermaid fenced blocks in the output */
  blocks: number;
  /** the output has text besides the fenced block(s) */
  extraText: boolean;
  valid: boolean;
  error?: string;
  /** e.g. "flowchart-v2", "sequence" */
  diagramType?: string;
  nodes?: number;
  edges?: number;
  /** diamond (rhombus) nodes */
  decisions?: number;
  subgraphs?: number;
  subgraphTitles?: string[];
  /** edges with a label (|yes| …) */
  labelledEdges?: number;
  /** the graph has at least one cycle (e.g. an error → retry loop) */
  hasCycle?: boolean;
  /** node label texts */
  labels?: string[];
  /** edge label texts (e.g. statuses on the branches of a decision) */
  edgeLabels?: string[];
}

type MermaidApi = typeof import('mermaid').default;
const g = globalThis as unknown as { __benchMermaid?: Promise<MermaidApi> };

async function loadMermaid(): Promise<MermaidApi> {
  return (g.__benchMermaid ??= (async () => {
    const { default: DOMPurify } = await import('dompurify');
    const dp = DOMPurify as unknown as Record<string, unknown>;
    if (typeof dp.addHook !== 'function') {
      Object.assign(dp, { addHook() {}, removeHook() {}, removeHooks() {}, removeAllHooks() {}, sanitize: (s: unknown) => String(s) });
    }
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return mermaid;
  })());
}

const FENCE = /```mermaid[^\n]*\n([\s\S]*?)```/g;

function hasCycle(edges: { start: string; end: string }[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.start, [...(adj.get(e.start) ?? []), e.end]);
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  return [...adj.keys()].some((n) => visit(n));
}

/** Analyse the (first) ```mermaid block of a model output. */
export async function analyzeMermaid(output: string): Promise<MermaidAnalysis> {
  const blocks = [...output.matchAll(FENCE)];
  const extraText = output.replace(FENCE, '').trim().length > 0;
  const source = blocks[0]?.[1]?.trim();
  if (!source) return { blocks: 0, extraText, valid: false, error: 'no ```mermaid code block' };
  try {
    const mermaid = await loadMermaid();
    const parsed = await mermaid.parse(source);
    if (!parsed) return { blocks: blocks.length, extraText, valid: false, error: 'not a Mermaid diagram' };
    const base: MermaidAnalysis = { blocks: blocks.length, extraText, valid: true, diagramType: parsed.diagramType };
    if (!parsed.diagramType.startsWith('flowchart')) return base;
    // flowcharts: read the parsed graph for structural checks
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    const db = diagram.db as unknown as {
      getVertices():
        Map<string, { id: string; type?: string; text?: string }> | Record<string, { id: string; type?: string; text?: string }>;
      getEdges(): { start: string; end: string; text?: string }[];
      getSubGraphs(): { id: string; title: string; nodes: string[] }[];
    };
    const v = db.getVertices();
    const vertices = v instanceof Map ? [...v.values()] : Object.values(v);
    const edges = db.getEdges();
    const subs = db.getSubGraphs();
    const subIds = new Set(subs.map((s) => s.id));
    const nodes = vertices.filter((x) => !subIds.has(x.id));
    return {
      ...base,
      nodes: nodes.length,
      edges: edges.length,
      decisions: nodes.filter((x) => x.type === 'diamond').length,
      subgraphs: subs.length,
      subgraphTitles: subs.map((s) => s.title),
      labelledEdges: edges.filter((e) => e.text?.trim()).length,
      hasCycle: hasCycle(edges),
      labels: nodes.map((x) => x.text ?? x.id),
      edgeLabels: edges.map((e) => e.text?.trim() ?? '').filter(Boolean),
    };
  } catch (e) {
    // "Parse error on line 2:" + "Expecting 'SQE', ... got 'PS'" (the source excerpt in between is noise)
    const lines = String((e as Error).message ?? e)
      .split('\n')
      .filter((l) => l.trim());
    const error = [lines[0], lines.length > 1 ? lines[lines.length - 1] : ''].filter(Boolean).join(' ').slice(0, 240);
    return { blocks: blocks.length, extraText, valid: false, error };
  }
}
