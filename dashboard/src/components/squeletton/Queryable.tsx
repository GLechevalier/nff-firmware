import { useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Device } from '../../types/device';
import type { OnQueryClick } from '../../types/query';

interface QueryableProps {
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
  /** Human-readable field name shown in the popup header (e.g. "Firmware Version"). */
  field: string;
  /** Raw value handed to the agent; an empty/nullish value is not click-able. */
  value: string | null | undefined;
  /** Device-scoped query (device tables/detail). */
  device?: Device;
  /** Entity label when the value isn't a device (e.g. "Firmware v1.2.3"). */
  subject?: string;
  /** Extra context lines handed to the agent. */
  details?: Record<string, string>;
  /** Element to render as — `td` inside tables, `span`/`div` elsewhere. */
  as?: 'span' | 'td' | 'div';
  children: ReactNode;
  style?: CSSProperties;
}

/**
 * Single source of truth for the "click a value to ask the agent about it" affordance.
 * When query mode is on and the value is non-empty, it adds the crosshair cursor, the
 * pale-yellow hover highlight, a trailing ⊕ marker, and on click opens the QueryPopup
 * anchored to the element. Lifted from the original inline QCell/Field patterns so the
 * look is identical everywhere.
 */
export function Queryable({
  queryMode, onQueryClick, field, value, device, subject, details, as = 'span', children, style,
}: QueryableProps) {
  const [hovered, setHovered] = useState(false);
  const queryable = !!queryMode && !!value && !!onQueryClick;

  const isFlex = String(style?.display ?? '').includes('flex');
  const mergedStyle: CSSProperties = {
    ...style,
    cursor: queryable ? 'crosshair' : (style?.cursor ?? 'default'),
    background: queryable && hovered ? '#fef3c7' : (style?.background ?? 'transparent'),
    outline: queryable && hovered ? '1px dashed #d97706' : (style?.outline ?? 'none'),
    transition: 'background 0.1s',
  };

  const handlers = queryable
    ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onClick: (e: ReactMouseEvent) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onQueryClick!({ x: rect.left, y: rect.bottom }, { field, value: value as string, device, subject, details });
        },
        title: `Query "${field}"${device ? ` on ${device.name}` : subject ? ` on ${subject}` : ''}`,
      }
    : {};

  const marker = queryable
    ? <span style={{ marginLeft: isFlex ? 0 : as === 'td' ? 5 : 4, color: '#d97706', fontSize: 10 }}>⊕</span>
    : null;

  const Tag = as as 'span';
  return (
    <Tag style={mergedStyle} {...handlers}>
      {children}
      {marker}
    </Tag>
  );
}
