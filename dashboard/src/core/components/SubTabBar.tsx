// Sub-navigation for the active sidebar group, Supabase-style: on desktop a
// vertical panel to the right of the icon rail (the rail is the global nav,
// this lists the section's pages); on phones the original horizontal segmented
// control under the header. Both variants live here — App.tsx mounts
// `variant="panel"` in the top-level flex row and `variant="strip"` inside the
// content column, each hidden at the other breakpoint.
import { Fragment } from 'react';
import { ACCENT_FILL } from './Sidebar';

// Generic over the id type: admin tabs pass `Tab`, and in hosted mode the Ops
// panel passes the embedded dashboard's group ids (plain strings).
export function SubTabBar<T extends string>({
  variant,
  label,
  tabs,
  active,
  onChange,
}: {
  variant: 'panel' | 'strip';
  label: string;
  tabs: Array<{ id: T; label: string; heading?: string }>;
  active: string;
  onChange: (tab: T) => void;
}) {
  if (variant === 'panel') {
    // view-transition-name: slides in from behind the rail when it enters during a
    // view transition (the brain panel's ⤢ zoom) — see theme.css `sub-tabs`.
    return (
      <div className="hidden w-44 shrink-0 flex-col border-r border-ink md:flex [view-transition-name:sub-tabs]">
        <div className="border-b border-hairline px-3 pb-2 pt-3 text-sm font-bold text-ink">{label}</div>
        <div className="flex flex-col overflow-y-auto pt-1">
          {tabs.map((t) => (
            <Fragment key={t.id}>
              {t.heading && (
                <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-widest text-faint">
                  {t.heading}
                </div>
              )}
              <button
                data-tour={`subtab-${t.id}`}
              onClick={() => onChange(t.id)}
                className={`flex h-8 w-full items-center px-3 text-left text-[13px] ${
                  t.id === active ? 'bg-ink font-bold text-paper' : 'text-muted hover:text-ink'
                }`}
                style={t.id === active ? ACCENT_FILL : undefined}
              >
                {t.label}
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 overflow-x-auto border-b border-ink md:hidden">
      {tabs.map((t) => (
        <button
          key={t.id}
          data-tour={`subtab-${t.id}`}
              onClick={() => onChange(t.id)}
          className={`flex-1 whitespace-nowrap border-r border-ink px-2 py-1.5 text-xs last:border-r-0 ${
            t.id === active ? 'bg-ink font-bold text-paper' : 'text-muted hover:text-ink'
          }`}
          style={t.id === active ? ACCENT_FILL : undefined}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
