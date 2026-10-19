// The Store: the toggleable parts of the app, one row per add-on, switch + settings arrow.
// Extracted from the admin's SettingsTab when the admin UI left for nff-admin (Oct 2026,
// techforge docs/handoff-app-admin.md); the adapter it renders is built by src/lib/store.tsx.
import { Fragment, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Tab } from '../../core/components/Sidebar';

// The on/off switch a Store row shows.
export function PermissionSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-green-600' : 'border border-hairline bg-elevated'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 block h-4 w-4 rounded-full border border-hairline bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  );
}

// Same catalog-in-UI / missing-entry-means-installed shape as Permissions.
export interface StoreAdapter {
  // `badge` replaces the toggle with a static pill (e.g. an unreleased app
  // marked "Building…") — there's nothing to install/remove yet.
  // `settingsTab` adds an arrow that REVEALS the add-on's own settings inline,
  // under the row (the host can supply the panel — see StoreSection's
  // renderSettings — else the matching Settings section renders itself).
  // `tools` makes the row a condensed sub-app: an arrow expands a sub-list of
  // its parts, each with its own switch (nff-app's Dev row — lib/store.tsx).
  // A tool's `section` is the job it does: the sub-page groups the tools under
  // collapsible headings (the developer stack by job), each with its own
  // arrow. The caller hands the tools in heading order (DEV_SECTIONS).
  catalog: StoreEntry[];
  hidden: string[];
  toggle(key: string): void;
}

interface StoreEntry {
  key: string;
  label: string;
  description?: string;
  icon?: ReactElement;
  badge?: string;
  settingsTab?: Tab;
  tools?: StoreEntry[];
  section?: string;
  // The brain pitch (storeCatalog): what connecting adds, and what it lets you ask.
  brainAdds?: string;
  ask?: string[];
}

function StoreRow({
  entry, adapter, onSettings, settingsOpen, nested, expanded, onExpand, delay,
}: {
  entry: StoreEntry;
  adapter: StoreAdapter;
  // The settings arrow's action: reveal the inline panel, or (no panel to
  // show) whatever the host does instead. `settingsOpen` is undefined when
  // there's nothing to reveal, so the arrow doesn't pretend to turn.
  onSettings?: () => void;
  settingsOpen?: boolean;
  nested?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  // Stagger (ms) for the reveal — a revealed row cascades in after the ones above it.
  delay?: number;
}) {
  const { key, label, description, icon, badge, brainAdds, ask } = entry;
  return (
    <div
      className={`flex items-center gap-3 py-2 pr-3 ${nested ? 'pl-9' : 'pl-3'}`}
      {...(delay != null && { 'data-store-reveal': '', style: REVEAL(delay) })}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <span className="text-sm text-ink">{label}</span>
        {description && <p className="text-xs text-muted">{description}</p>}
        {brainAdds && <p className="text-[11px] text-faint">Adds to your brain: {brainAdds}</p>}
        {ask && ask.length > 0 && (
          <p className="text-[11px] text-faint">Ask: {ask.map((q) => `“${q}”`).join(' · ')}</p>
        )}
      </div>
      {badge ? (
        <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10px] uppercase tracking-label text-faint">
          {badge}
        </span>
      ) : (
        <PermissionSwitch checked={!adapter.hidden.includes(key)} onChange={() => adapter.toggle(key)} />
      )}
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          title={`${label} tools`}
          aria-label={`${label} tools`}
          aria-expanded={expanded}
          className="shrink-0 text-muted hover:text-ink"
        >
          <ChevronRight
            size={16}
            className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          onClick={onSettings}
          title={`${label} settings`}
          aria-label={`${label} settings`}
          {...(settingsOpen != null && { 'aria-expanded': settingsOpen })}
          className="shrink-0 text-muted hover:text-ink"
        >
          <ChevronRight
            size={16}
            className={`transition-transform duration-200 motion-reduce:transition-none ${settingsOpen ? 'rotate-90' : ''}`}
          />
        </button>
      )}
    </div>
  );
}

/** The house reveal (index.css's nff-node-in: fade + 6px rise), staggered so an
 * opening list cascades instead of snapping in. `both` holds it hidden through
 * the delay; prefers-reduced-motion drops it (see [data-store-reveal]). */
const REVEAL = (delay: number) => ({ animation: 'nff-node-in 0.22s ease-out both', animationDelay: `${delay}ms` });

/** Tools in the given order, cut into [section, tools] runs (undefined = no heading). */
function bySection(tools: StoreEntry[]): [string | undefined, StoreEntry[]][] {
  const runs: [string | undefined, StoreEntry[]][] = [];
  for (const tool of tools) {
    const last = runs[runs.length - 1];
    if (last && last[0] === tool.section) last[1].push(tool);
    else runs.push([tool.section, [tool]]);
  }
  return runs;
}

export function StoreSection({
  adapter,
  renderSettings,
  onOpen,
  focus,
}: {
  adapter: StoreAdapter;
  // The panel a row's settings arrow reveals. Hosts whose add-on settings are
  // scoped differently from the platform console's pass their own (nff-app's
  // dashboard: the workspace's own /api/gcp client). Returning null says "I
  // have nothing to reveal" and falls back to onOpen.
  renderSettings?: (tab: Tab) => ReactNode;
  // Fallback for a row with no panel: navigate/jump wherever the host wants.
  onOpen?: (tab: Tab) => void;
  // An app or tool key to open on: that app's tools unfold, and a tool's job
  // section + settings panel open with it (nff-app's brain side panel lands on
  // the row a master node stands for). Initial state only.
  focus?: string;
}) {
  // Everything starts closed unless focused: one sub-app open at a time, and
  // every job section inside it shut until its arrow is clicked — the Store
  // opens as a short list, not a wall of switches.
  const focusApp = focus ? adapter.catalog.find((e) => e.key === focus || e.tools?.some((t) => t.key === focus)) : undefined;
  const focusTool = focusApp?.tools?.find((t) => t.key === focus);
  const [openKey, setOpenKey] = useState<string | null>(focusApp?.key ?? null);
  const [openSections, setOpenSections] = useState<string[]>(focusTool?.section ? [focusTool.section] : []);
  // A focused tool's settings open, whether it sits under its app row or is the whole catalog.
  const [openSettings, setOpenSettings] = useState<string | null>(focus ?? null);
  const toggleSection = (section: string) =>
    setOpenSections((open) => (open.includes(section) ? open.filter((s) => s !== section) : [...open, section]));

  // One row, plus the settings panel its arrow reveals underneath.
  const row = (
    entry: StoreEntry,
    extra: { nested?: boolean; expanded?: boolean; onExpand?: () => void; delay?: number },
  ) => {
    const panel = entry.settingsTab
      ? renderSettings
        ? renderSettings(entry.settingsTab)
        : null
      : null;
    const open = openSettings === entry.key;
    return (
      <Fragment key={entry.key}>
        <StoreRow
          entry={entry}
          adapter={adapter}
          {...extra}
          settingsOpen={panel ? open : undefined}
          onSettings={
            panel
              ? () => setOpenSettings(open ? null : entry.key)
              : onOpen && entry.settingsTab
                ? () => onOpen(entry.settingsTab!)
                : undefined
          }
        />
        {panel && open && (
          <div
            data-store-reveal=""
            style={REVEAL(0)}
            className={`bg-elevated py-3 pr-3 ${extra.nested ? 'pl-9' : 'pl-3'}`}
          >
            {panel}
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <div>
      {/* A focused panel shows one app row, which carries its own label — no heading over it. */}
      {!focusApp && (
        <>
          <h2 className="text-sm font-bold tracking-label text-ink">Store</h2>
          <p className="mt-1 text-xs text-muted">
            Add or remove parts of the app. Removed parts disappear from your navigation; nothing is deleted — switch a
            part back on to restore it.
          </p>
        </>
      )}

      {/* Focused on one app (the brain's side panel): the panel is the box already,
          so the list runs flat — dividers only, no frame around it. */}
      <div className={`divide-y divide-hairline ${focusApp ? '' : 'mt-2 border border-hairline'}`}>
        {adapter.catalog.map((entry) => {
          const expanded = openKey === entry.key;
          return (
            <div key={entry.key} className="divide-y divide-hairline">
              {row(entry, {
                expanded,
                onExpand: entry.tools ? () => setOpenKey(expanded ? null : entry.key) : undefined,
              })}
              {expanded &&
                bySection(entry.tools ?? []).map(([section, tools], runIndex) => {
                  const shown = !section || openSections.includes(section);
                  return (
                    <Fragment key={section ?? tools[0].key}>
                      {section && (
                        <button
                          type="button"
                          onClick={() => toggleSection(section)}
                          aria-expanded={shown}
                          data-store-reveal=""
                          style={REVEAL(runIndex * 25)}
                          className="flex w-full items-center gap-1.5 bg-elevated py-1.5 pl-6 pr-3 text-left text-[10px] font-bold uppercase tracking-label text-faint transition-colors hover:text-ink"
                        >
                          <ChevronRight
                            size={12}
                            className={`transition-transform duration-200 motion-reduce:transition-none ${shown ? 'rotate-90' : ''}`}
                          />
                          {section}
                          <span className="ml-auto normal-case tracking-normal">{tools.length}</span>
                        </button>
                      )}
                      {shown && tools.map((tool, i) => row(tool, { nested: true, delay: i * 25 }))}
                    </Fragment>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
