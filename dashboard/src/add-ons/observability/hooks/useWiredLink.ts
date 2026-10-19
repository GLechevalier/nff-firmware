// useWiredLink.ts — observe the tab-wide wired (USB/PPPoS) link from any component.
// The link itself lives in src/lib/ppplink/linkStore.ts and outlives whichever modal created it.

import { useSyncExternalStore } from 'react';
import {
  getConsoleSnapshot,
  getLinkDeviceId,
  getLinkState,
  subscribeConsole,
  subscribeLink,
} from '../../../lib/ppplink/linkStore';
import type { WiredLinkState } from '../../../lib/ppplink/index';

export function useWiredLinkState(): WiredLinkState | null {
  return useSyncExternalStore(subscribeLink, getLinkState);
}

/** The fleet device the wired link is attached to, or null if unknown (resumed link / pre-feature flash). */
export function useWiredLinkDeviceId(): string | null {
  return useSyncExternalStore(subscribeLink, getLinkDeviceId);
}

/** Live device serial console — the lines the firmware sends over the PROTO_CONSOLE (0xC0FF) channel. */
export function useWiredConsole(): readonly string[] {
  return useSyncExternalStore(subscribeConsole, getConsoleSnapshot);
}
