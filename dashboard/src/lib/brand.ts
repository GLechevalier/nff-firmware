// Accent tokens for branded tenant domains (0105). TenantContext sets the CSS
// variables on :root when the tenant has an accent_color; unbranded domains —
// and the standalone demo/floor bundles, which mount without a TenantProvider —
// never set them, so the stock ink fallbacks apply. Pure CSS-var strings on
// purpose: no hook, so any component (including ones shared with demo/floor)
// can consume them safely.
//
// Usage: replace a primary fill's `background: '#000'` with BRAND_ACCENT (and a
// hard-coded '#222' hover with BRAND_ACCENT_HOVER), or spread `accentFill` into
// a style object. Borders, dividers and data surfaces stay ink — only primary
// fills carry the brand.

export const BRAND_ACCENT = 'var(--brand-accent, #000)';
export const BRAND_ACCENT_HOVER = 'var(--brand-accent-hover, #222)';

export const accentFill = { background: BRAND_ACCENT, color: '#fff' } as const;
