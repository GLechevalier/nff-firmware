import type { ComponentType } from 'react';
import type { TabId } from '../components/squeletton/TabBar';

/** Per-tab reconfiguration. Every tab ships its default body; registering a
 *  component here replaces that tab's body wholesale while the default stays
 *  in the tree (remove the entry to restore it).
 *
 *  Contract: an override is SELF-CONTAINED — it receives no props and pulls
 *  whatever it needs via hooks/context (the registry stays prop-agnostic
 *  across 19 differently-shaped tabs). Unlike defaults (which stay mounted,
 *  display-toggled, for state retention), an override mounts only while its
 *  tab is active — so it may freely reuse components that also live in other
 *  tabs (brain, chat, …) without double-mount hazards.
 *
 *  Wiring lives in App.tsx: `shownTab` nulls the default display toggles when
 *  the active tab is overridden, and the override renders in a single slot. */
export const TAB_OVERRIDES: Partial<Record<TabId, ComponentType>> = {};
