'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { MermaidDiagram } from './mermaid-diagram';
import { normalizeMath } from '@/lib/markdown-math';

/**
 * Model output rendered as Markdown: GFM (tables, task lists, strikethrough), LaTeX math (KaTeX) and ```mermaid
 * diagrams. Model output is untrusted: react-markdown ignores raw HTML and drops javascript: URLs; links open in a
 * new tab without referrer; images are shown as links instead of being loaded, so an answer can't make the page
 * fetch remote URLs; KaTeX runs with trust off (no \href/\url/\includegraphics) and Mermaid in strict mode.
 */

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const textOf = (n: HastNode | undefined): string =>
  n ? (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join('')) : '';

const components: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer nofollow" className="md-img">
      [image{alt ? `: ${alt}` : ''}]
    </a>
  ),
  // ```mermaid fences become diagrams; every other block stays a code block
  pre: ({ node, children }) => {
    const code = (node as HastNode | undefined)?.children?.[0];
    const cls = code?.tagName === 'code' ? code.properties?.className : undefined;
    if (Array.isArray(cls) && cls.includes('language-mermaid')) return <MermaidDiagram chart={textOf(code).trim()} />;
    return <pre>{children}</pre>;
  },
};

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, trust: false, strict: 'ignore' }],
];

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`md-preview ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}
