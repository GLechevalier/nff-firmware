import { Markdown } from '../../../core/components/Markdown';
import { BasicTool } from './BasicTool';
import { FileDiff } from './FileDiff';
import type { Part } from '../types';

// The part switch — opencode's message-part.tsx. Every renderer below is dumb:
// it takes one Part and paints it. Nothing here knows a Supabase table exists.

interface Props {
  part: Part;
  /** Only the newest choices block is answerable; older ones render disabled. */
  onChoose?: (label: string) => void;
  interactive?: boolean;
}

export function MessagePart({ part, onChoose, interactive }: Props) {
  switch (part.kind) {
    case 'text':
      return (
        <div data-component="text-part" data-streaming={part.streaming ? 'true' : undefined}>
          <div data-component="markdown">
            <Markdown text={part.text} className="text-sm" />
          </div>
        </div>
      );

    case 'status':
      return (
        <div data-component="status-part" data-variant={part.variant}>
          {part.variant === 'narration' && <span data-component="spinner" />}
          <span>{part.text}</span>
        </div>
      );

    case 'tool':
      return <BasicTool part={part} />;

    case 'file':
      return <FileDiff part={part} />;

    case 'error':
      return <div className="error-card">{part.text}</div>;

    case 'choices':
      return (
        <div data-slot="question-options">
          {part.options.map((c) => (
            <button
              key={c.label}
              type="button"
              data-slot="question-option"
              disabled={!interactive || !onChoose}
              onClick={() => onChoose?.(c.label)}
            >
              <span data-slot="option-label">{c.label}</span>
              {c.detail && <span data-slot="option-description">{c.detail}</span>}
            </button>
          ))}
        </div>
      );
  }
}
