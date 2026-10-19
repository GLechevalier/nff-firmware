import type React from 'react';
import type { ReactNode } from 'react';
import { CopyButton } from '../../../components/squeletton/CopyButton';

interface Props {
  // Content to copy — a thunk for large/derived text computed lazily on click.
  value: string | (() => string);
  children: ReactNode;
  // Light glyph for blocks over a dark (#000) background.
  dark?: boolean;
  // Merged onto the relative container so scroll panes can carry flex:1 / minHeight:0.
  style?: React.CSSProperties;
  title?: string;
}

/**
 * Pins a copy icon to the top-right of any output/log block. Wrap a <pre> or scroll
 * area in this to make its text copyable without disturbing the block's own layout.
 */
export function CopyOverlay({ value, children, dark = false, style, title = 'Copy' }: Props) {
  return (
    <div style={{ position: 'relative', ...style }}>
      {children}
      <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}>
        <CopyButton variant="icon" value={value} dark={dark} title={title} />
      </div>
    </div>
  );
}
