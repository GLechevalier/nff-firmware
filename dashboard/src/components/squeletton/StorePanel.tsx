import { StoreSection, type StoreAdapter } from './StoreSection';

// The Store, in the brain's side column (BrainCard `nodePanel`, wired in App.tsx).
// The hub opens the whole Store; Admin / Dev / Finance open just their app row;
// a tool master opens ONLY its own row (`focus`): its switch plus its settings
// unfolded, inline — never a modal, no parent app, no siblings. The Devices
// node shows nothing on top (its hardware actions live in the Devices → Hardware
// tab, add-ons/observability/components/HardwareTab.tsx).

export function StorePanel({ store, focus }: {
  store?: StoreAdapter;
  focus?: string;      // a Store app or tool key; undefined = the whole Store
}) {
  // An app key: just that app row. A tool key: just that tool's row (switch + settings),
  // not its app and siblings. A key no row knows (docker's `dev`) shows everything.
  const focusApp = focus && store ? store.catalog.find((e) => e.key === focus || e.tools?.some((t) => t.key === focus)) : undefined;
  const focusTool = focusApp?.tools?.find((t) => t.key === focus);
  const adapter = store && focusApp ? { ...store, catalog: [focusTool ?? focusApp] } : store;
  if (!adapter) return null;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto px-3 py-2 text-xs text-ink">
      <StoreSection
        adapter={adapter}
        focus={focus}
        renderSettings={() => null}
      />
    </div>
  );
}
