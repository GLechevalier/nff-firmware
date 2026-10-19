// Dev-only feature gate. The Security (vulnerability-tree) tab is a developer
// surface and must not appear in normal/production builds.
//
// True when running the local dev server (`vite --mode local.dev`) or when
// VITE_PENTESTER_DEV_MODE=true is set (mirrors nff-pentester's PENTESTER_DEV_MODE,
// but VITE_-prefixed so Vite exposes it to the client bundle).
export const DEV_MODE =
  import.meta.env.MODE === 'local.dev' ||
  String(import.meta.env.VITE_PENTESTER_DEV_MODE) === 'true';
