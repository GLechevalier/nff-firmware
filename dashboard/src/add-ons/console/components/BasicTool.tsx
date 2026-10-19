import { useState } from 'react';
import type { Part } from '../types';

// One tool call, ported from opencode's basic-tool.tsx.
//
// Collapsed: chevron, tool name, up to three args, and the output size on the
// right. Expanded: every param on its own row, then the raw output. Upstream
// wraps a pending title in <TextShimmer>; that reads as a CSS gradient sweep
// here (see console.css [data-status="running"]).

const COLLAPSED_ARGS = 3;

type ToolPart = Extract<Part, { kind: 'tool' }>;

function summary(part: ToolPart): string | null {
  if (part.status === 'error') return 'failed';
  if (!part.output) return null;
  const lines = part.output.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'}`;
}

export function BasicTool({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const expandable = part.params.length > 0 || !!part.output;
  const meta = summary(part);

  return (
    <div data-component="tool-part-wrapper">
      <button
        type="button"
        data-component="tool-trigger"
        data-status={part.status}
        data-edit={part.edit ? 'true' : undefined}
        data-clickable={expandable ? 'true' : undefined}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => expandable && setOpen((v) => !v)}
      >
        <span data-slot="basic-tool-tool-indicator" aria-hidden="true">
          {part.status === 'running' ? <span data-component="spinner" /> : expandable ? '▸' : '·'}
        </span>
        <span data-slot="basic-tool-tool-info-main">
          {part.server && <span data-slot="basic-tool-tool-server">{part.server}</span>}
          <span data-slot="basic-tool-tool-title">{part.tool}</span>
          {!open && part.params.slice(0, COLLAPSED_ARGS).map((p) => (
            <span key={p.name} data-slot="basic-tool-tool-arg">
              {p.name} {p.value}
            </span>
          ))}
        </span>
        {meta && <span data-slot="basic-tool-tool-action">{meta}</span>}
      </button>

      {open && part.params.length > 0 && (
        <div data-slot="basic-tool-params">
          {part.params.map((p) => (
            <div key={p.name} style={{ display: 'contents' }}>
              <span data-slot="basic-tool-param-name">{p.name}</span>
              <span data-slot="basic-tool-param-value">{p.value}</span>
            </div>
          ))}
        </div>
      )}

      {open && part.output && (
        <div data-component="bash-output">
          <div data-slot="bash-scroll">
            <pre data-slot="bash-pre">
              <code>{part.output}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
