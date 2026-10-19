import { isValidElement, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CopyButton } from './CopyButton';
import { CodeHighlight, langFromClassName } from './CodeHighlight';

// Flatten react-markdown's code children (string or nested nodes) to the raw source text.
function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

// A fenced code block: subtly syntax-highlighted (CodeHighlight) with a copy icon that appears
// on hover. The text is read from the rendered <pre> on click, so the copied value always
// matches what's shown. react-markdown renders fences as <pre><code class="language-x">…; this
// is the `pre` override, so it pulls the language + raw source off the inner <code> element.
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [hover, setHover] = useState(false);

  const codeEl = Array.isArray(children) ? children[0] : children;
  const className = isValidElement(codeEl)
    ? (codeEl.props as { className?: string }).className
    : undefined;
  const raw = nodeText(codeEl);

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <CodeHighlight
        code={raw}
        language={langFromClassName(className)}
        style={{
          background: 'rgba(0,0,0,0.08)',
          padding: '6px 8px',
          borderRadius: 4,
          margin: '0 0 6px',
          overflowX: 'auto',
          fontSize: '0.92em',
          whiteSpace: 'pre',
        }}
        preRef={ref}
      />
      {hover && (
        <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}>
          <CopyButton variant="icon" title="Copy code" value={() => ref.current?.textContent ?? ''} />
        </div>
      )}
    </div>
  );
}

// Reusable markdown renderer. react-markdown does not render raw HTML and does not
// use dangerouslySetInnerHTML, so this is XSS-safe without extra sanitization.
//
// The component map below tightens every element so rendered markdown sits naturally
// inside the compact monospace chat bubbles in ChatPanel (small font, tight margins).

const components: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 6px' }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  del: ({ children }) => <del>{children}</del>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: 'inherit', textDecoration: 'underline' }}
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // Block code carries a language- className from the fence; inline code does not.
    const isBlock = /language-/.test(className ?? '');
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code
        style={{
          background: 'rgba(0,0,0,0.08)',
          padding: '1px 4px',
          borderRadius: 3,
          fontSize: '0.92em',
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  ul: ({ children }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  h1: ({ children }) => <h1 style={{ fontSize: '1.3em', fontWeight: 700, margin: '0 0 6px' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: '1.2em', fontWeight: 700, margin: '0 0 6px' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: '1.1em', fontWeight: 700, margin: '0 0 6px' }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ fontSize: '1em', fontWeight: 700, margin: '0 0 6px' }}>{children}</h4>,
  h5: ({ children }) => <h5 style={{ fontSize: '1em', fontWeight: 700, margin: '0 0 6px' }}>{children}</h5>,
  h6: ({ children }) => <h6 style={{ fontSize: '1em', fontWeight: 700, margin: '0 0 6px' }}>{children}</h6>,
  blockquote: ({ children }) => (
    <blockquote
      style={{ margin: '0 0 6px', paddingLeft: 8, borderLeft: '3px solid rgba(0,0,0,0.2)', color: 'inherit' }}
    >
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <table style={{ borderCollapse: 'collapse', margin: '0 0 6px', fontSize: '0.92em' }}>{children}</table>
  ),
  th: ({ children }) => (
    <th style={{ border: '1px solid rgba(0,0,0,0.3)', padding: '2px 6px', textAlign: 'left' }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{ border: '1px solid rgba(0,0,0,0.3)', padding: '2px 6px' }}>{children}</td>
  ),
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid rgba(0,0,0,0.2)', margin: '6px 0' }} />,
};

export function Markdown({ children }: { children: string }) {
  return (
    // Strip the trailing margin off the last block so bubbles don't carry dead space.
    <div style={{ marginBottom: -6 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
