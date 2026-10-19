import { flushSync } from 'react-dom';

// Run a state update inside a View Transition: the browser cross-fades the
// page and MORPHS any element carrying a `view-transition-name` from its old
// box to its new one (BrainCard's `brain-graph` — the Overview card gliding
// into the Chat tab's pane). flushSync so the DOM is updated synchronously
// inside the callback, as the API requires. Plain update where the API is
// missing or the user asked for reduced motion.
export function withViewTransition(update: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!d.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  d.startViewTransition(() => flushSync(update));
}
