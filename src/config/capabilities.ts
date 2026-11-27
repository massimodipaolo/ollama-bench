/**
 * Capabilities group tests by what they *measure* (not by what they require: every chat test requires `completion`).
 * A test may count toward several capabilities. Used by the dashboard's "By capability" view and capability batches.
 * Plain data: imported by server and client code alike.
 */
export interface CapabilityDef {
  id: string;
  label: string;
  description: string;
  tests: string[];
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'text',
    label: 'Text',
    description: 'Writing, structured output, document conversion and grounded answers',
    tests: ['text-generation', 'structured-output', 'doc-to-markdown', 'rag'],
  },
  {
    id: 'vision',
    label: 'Vision',
    description: 'Reading and reasoning over images, documents and charts',
    tests: ['image-recognition', 'omnidocbench', 'mmmu-pro'],
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Function calling, MCP servers and web search',
    tests: ['tool-use', 'bfcl', 'mcp', 'web-search'],
  },
  {
    id: 'coding',
    label: 'Coding',
    description: 'Code that passes unit tests (six languages) and agentic terminal tasks',
    tests: ['terminal-bench'],
  },
  {
    id: 'retrieval',
    label: 'Retrieval',
    description: 'Embeddings, reranking and retrieval-augmented answers',
    tests: ['embeddings', 'reranking', 'rag'],
  },
];

export const getCapability = (id: string | undefined) => CAPABILITIES.find((c) => c.id === id);
