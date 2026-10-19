/**
 * A thin, always-visible strip across the top of the authenticated dashboard
 * that explicitly announces the app is in beta. Mounted once at App's layout
 * root, so it only ever renders for signed-in users — the login page, the
 * public demo embed, and the floor showroom never show it.
 *
 * Follows the dashboard's ink-on-paper / monospace register: hard border,
 * inverted (black-on-white) so it's unmissable but on-brand.
 */
import type { ReactNode } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';

// Demo mode takes this same slot (App.tsx) with its own tag + message + Exit,
// so the strip never stacks: the demo REPLACES the beta notice.
export function BetaBanner({
  tag = 'BETA',
  children = 'This dashboard is a work in progress; features may change.',
  action,
}: { tag?: string; children?: ReactNode; action?: ReactNode } = {}) {
  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        background: BRAND_ACCENT,
        color: '#fff',
        borderBottom: '1px solid #000',
        padding: '4px 12px',
        fontSize: 11,
        letterSpacing: 0.4,
      }}
    >
      <span
        style={{
          border: '1px solid #fff',
          padding: '0 5px',
          fontWeight: 'bold',
          letterSpacing: 0.8,
        }}
      >
        {tag}
      </span>
      <span>{children}</span>
      {action}
    </div>
  );
}
