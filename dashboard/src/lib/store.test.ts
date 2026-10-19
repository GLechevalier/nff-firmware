import { describe, expect, it } from 'vitest';
import { buildStore, hiddenGroups, storeFocusOf } from './store';
import { DEV_SECTIONS } from '../core/storeCatalog';

// The Dev sub-app inverts two keys (Code/Deploy ship off), so the Store switch
// and the sidebar filter both go through hiddenGroups. Check they agree.
function store(hidden: string[]) {
  let next = hidden;
  const s = buildStore(
    hidden,
    (key) => { next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]; },
    (hide, show) => { next = [...hidden.filter((k) => ![...hide, ...show].includes(k)), ...hide]; },
  );
  return { ...s, after: (key: string) => { s.toggle(key); return next; } };
}

describe('Dev sub-app', () => {
  it('ships installed with GitHub only', () => {
    expect(hiddenGroups([]).sort()).toEqual(['code', 'deploy']);
    const s = store([]);
    expect(s.hidden).not.toContain('dev-app');
    expect(s.hidden).not.toContain('github');
    expect(s.hidden).toContain('code');
  });

  it('switching the app off hides every tool', () => {
    const off = store([]).after('dev-app');
    expect(hiddenGroups(off).sort()).toEqual(['code', 'deploy', 'github']);
    expect(store(off).hidden).toContain('dev-app');
  });

  it('switching it back on restores the GitHub-only default', () => {
    const off = store([]).after('dev-app');
    expect(store(off).after('dev-app')).toEqual([]);
  });

  it('a tool switch flips that tool only, inverted keys included', () => {
    expect(hiddenGroups(store([]).after('code'))).not.toContain('code');
    expect(hiddenGroups(store(['code']).after('code'))).toContain('code');
    expect(hiddenGroups(store([]).after('github'))).toContain('github');
  });

  it('Devices no longer owns the dev groups', () => {
    const noDevices = store([]).after('devices-app');
    expect(noDevices).not.toContain('github');
    expect(store(noDevices).hidden).toContain('devices-app');
  });
});

describe('Dev sub-page grouping', () => {
  const tools = buildStore([], () => {}, () => {}).catalog.find((e) => e.key === 'dev-app')!.tools!;

  it('files every tool under a known job, in DEV_SECTIONS order', () => {
    const seen: string[] = [];
    for (const t of tools) {
      expect(DEV_SECTIONS).toContain(t.section);
      // A heading is printed once, so a section must never come back later.
      if (t.section !== seen[seen.length - 1]) {
        expect(seen).not.toContain(t.section);
        seen.push(t.section!);
      }
    }
    expect(seen).toEqual(DEV_SECTIONS.filter((s) => seen.includes(s)));
  });

  it('covers the rows the stack calls out — CI, registries, auth, secrets, chat', () => {
    const keys = tools.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['github', 'registries', 'auth', 'secrets', 'slack']));
  });
});

// A brain master's side panel opens the Store on the row that master stands for.
describe('storeFocusOf', () => {
  it("maps the hub's Dev child to its app row", () => {
    expect(storeFocusOf({ kind: 'tab', tab: 'dev' })).toBe('dev-app');
  });
  it('is null for Devices (hardware actions only)', () => {
    expect(storeFocusOf({ kind: 'tab', tab: 'devices' })).toBeNull();
  });
  it('maps a tool master to its own Store row', () => {
    expect(storeFocusOf({ kind: 'tool', tool: 'github' })).toBe('github');
  });
  it('is null for a tool with no Store row and for plain nodes', () => {
    expect(storeFocusOf({ kind: 'tool', tool: 'growth' })).toBeNull(); // no storeKey
    expect(storeFocusOf({ kind: 'tab', tab: 'overview' })).toBeNull();
    expect(storeFocusOf(null)).toBeNull();
  });
});
