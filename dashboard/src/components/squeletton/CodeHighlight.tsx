import type React from 'react';
import { Highlight, type PrismTheme } from 'prism-react-renderer';

// Subtle, low-saturation syntax highlighting that fits the dashboard's monochrome b/w UI:
// color lands only on comments / strings / keywords / numbers, everything else stays near-black
// on white. Used by the Code tab's file viewer (firmware) and by Markdown fenced code blocks.

// A restrained palette — muted greys/greens/blues so the code reads as "tinted", not rainbow.
const mutedTheme: PrismTheme = {
  plain: { color: '#1a1a1a', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#6a737d', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: '#555' } },
    { types: ['namespace'], style: { opacity: 0.7 } },
    { types: ['string', 'attr-value', 'char', 'inserted'], style: { color: '#4d7a4d' } },
    { types: ['number', 'boolean', 'constant', 'symbol'], style: { color: '#8a6d3b' } },
    { types: ['keyword', 'selector', 'atrule', 'rule', 'important'], style: { color: '#3b5b8c', fontWeight: 'bold' } },
    { types: ['function', 'class-name', 'function-variable'], style: { color: '#5a3e85' } },
    { types: ['tag', 'operator', 'entity', 'url'], style: { color: '#3b5b8c' } },
    { types: ['attr-name', 'property'], style: { color: '#7a5a3b' } },
    { types: ['variable', 'deleted'], style: { color: '#9a3b3b' } },
  ],
};

// The same restrained idea, inverted for a dark background (the black agent console): light-grey
// plain text with subtle string/number/key tints that stay legible on #000.
export const darkTheme: PrismTheme = {
  plain: { color: '#cfcfcf', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#7d8590', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: '#8b8b8b' } },
    { types: ['namespace'], style: { opacity: 0.7 } },
    { types: ['string', 'attr-value', 'char', 'inserted'], style: { color: '#7bb37b' } },
    { types: ['number', 'boolean', 'constant', 'symbol'], style: { color: '#d1a86a' } },
    { types: ['keyword', 'selector', 'atrule', 'rule', 'important'], style: { color: '#79a6e0', fontWeight: 'bold' } },
    { types: ['function', 'class-name', 'function-variable'], style: { color: '#b892e0' } },
    { types: ['tag', 'operator', 'entity', 'url'], style: { color: '#79a6e0' } },
    { types: ['attr-name', 'property'], style: { color: '#e0b87a' } },
    { types: ['variable', 'deleted'], style: { color: '#e07a7a' } },
  ],
};

// Map a file path's extension to a Prism language id. Unknown → 'text' (renders plain, no throw).
export function langFromPath(path: string | null): string {
  const ext = (path ?? '').toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'ino': case 'cpp': case 'cc': case 'cxx': case 'c': case 'h': case 'hpp': case 'hxx':
      return 'cpp';
    case 'py': return 'python';
    case 'json': return 'json';
    case 'ts': case 'tsx': return 'tsx';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'jsx';
    case 'sh': case 'bash': case 'zsh': return 'bash';
    case 'md': case 'markdown': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'toml': return 'toml';
    case 'ini': case 'cfg': case 'conf': return 'ini';
    case 'html': case 'htm': return 'markup';
    case 'css': return 'css';
    case 'sql': return 'sql';
    case 'rs': return 'rust';
    case 'go': return 'go';
    default: return 'text';
  }
}

// Map a react-markdown fence className ("language-xxx") to a Prism language id.
export function langFromClassName(className: string | undefined): string {
  const m = /language-([\w-]+)/.exec(className ?? '');
  return m ? m[1] : 'text';
}

interface Props {
  code: string;
  language: string;
  // Merged onto the rendered <pre> so callers keep control of layout/scroll/padding.
  style?: React.CSSProperties;
  // Optional ref to the rendered <pre> (e.g. so a copy button can read its textContent).
  preRef?: React.Ref<HTMLPreElement>;
  // Palette override — defaults to the light `mutedTheme`. Pass `darkTheme` on a dark bg
  // (e.g. the black agent console) so the tokens stay legible.
  theme?: PrismTheme;
}

// Renders `code` as a syntax-highlighted <pre>. The caller owns sizing via `style`.
export function CodeHighlight({ code, language, style, preRef, theme = mutedTheme }: Props) {
  return (
    <Highlight code={code.replace(/\n$/, '')} language={language} theme={theme}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre ref={preRef} style={style}>
          {tokens.map((line, i) => {
            const lineProps = getLineProps({ line });
            return (
              <span key={i} {...lineProps} style={{ ...lineProps.style, display: 'block' }}>
                {line.map((token, key) => {
                  const tokenProps = getTokenProps({ token });
                  return <span key={key} {...tokenProps} />;
                })}
              </span>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}
