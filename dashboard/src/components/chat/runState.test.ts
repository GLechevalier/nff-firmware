import { describe, it, expect } from 'vitest';
import {
  isWorking,
  runNarration,
  runToolNames,
  NARRATION_PREFIX,
  SCHEDULE_PREFIX,
  STOP_PREFIX,
  type RunMessage,
} from './runState';

let n = 0;
const user = (content: string): RunMessage => ({ id: `u${++n}`, role: 'user', content });
const agent = (content: string): RunMessage => ({ id: `a${++n}`, role: 'agent', content });
const narrate = (content: string): RunMessage => agent(NARRATION_PREFIX + content);

describe('isWorking', () => {
  it('is false on an empty thread', () => {
    expect(isWorking([])).toBe(false);
  });

  it('is true right after the user sends', () => {
    expect(isWorking([user('what devices are online?')])).toBe(true);
  });

  it('stays true while the agent narrates — the regression this fixes', () => {
    expect(isWorking([user('q'), narrate('Listing devices…')])).toBe(true);
    expect(isWorking([user('q'), narrate('Listing devices…'), narrate('Reading crash abc…')])).toBe(true);
  });

  it('is false once a real reply lands', () => {
    expect(isWorking([user('q'), narrate('Listing devices…'), agent('Three devices are online.')])).toBe(false);
  });

  it('is false on the persistent ⏰ / ⏹ status lines — they end the run', () => {
    expect(isWorking([user('q'), agent(`${SCHEDULE_PREFIX}Resuming in ~5m.`)])).toBe(false);
    expect(isWorking([user('q'), agent(`${STOP_PREFIX}Stopped by user.`)])).toBe(false);
  });
});

describe('runNarration', () => {
  it('returns only this run’s narration, prefix stripped, oldest first', () => {
    const lines = runNarration([
      user('old question'),
      narrate('Stale step from the previous run'),
      agent('old answer'),
      user('new question'),
      narrate('Listing devices…'),
      narrate('Reading crash abc123…'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Listing devices…', 'Reading crash abc123…']);
  });

  it('ignores real replies and persistent status lines', () => {
    const lines = runNarration([
      user('q'),
      narrate('Listing devices…'),
      agent('a real interim reply'),
      agent(`${SCHEDULE_PREFIX}Resuming in ~5m.`),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Listing devices…']);
  });

  it('is empty with no user message, and empty before the agent starts', () => {
    expect(runNarration([agent('orphan row')])).toEqual([]);
    expect(runNarration([user('q')])).toEqual([]);
  });

  it('carries the row id so the ticker can key on it', () => {
    const row = narrate('Listing devices…');
    expect(runNarration([user('q'), row])).toEqual([{ id: row.id, text: 'Listing devices…' }]);
  });
});

describe('runToolNames', () => {
  it('keeps the tool names and drops the keepalive heartbeat lines', () => {
    const lines = runToolNames([
      user('q'),
      narrate('fleet_list_devices'),
      narrate('Still thinking… (~1m20s)'),
      narrate('get_crash'),
      narrate('Hang tight, still working…'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['fleet_list_devices', 'get_crash']);
  });
});
