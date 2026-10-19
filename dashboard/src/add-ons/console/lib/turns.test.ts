import { describe, expect, it } from 'vitest';
import { buildTurns, hasRunningJob, jobsOnly, type ConsoleInput, type FileInput, type MessageInput } from './turns';

const t = (s: number) => new Date(2026, 0, 1, 0, 0, s);

const msg = (id: string, role: 'user' | 'agent', content: string, s: number): MessageInput =>
  ({ id, role, content, timestamp: t(s) });
const entry = (id: string, type: ConsoleInput['type'], content: string, s: number): ConsoleInput =>
  ({ id, type, content, timestamp: t(s) });

const base = { messages: [], entries: [], files: [] as FileInput[] };

describe('buildTurns — window join', () => {
  it('assigns each console entry to the turn whose prompt precedes it', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'first', 10), msg('a1', 'agent', 'done', 20), msg('u2', 'user', 'second', 30), msg('a2', 'agent', 'done too', 40)],
      entries: [entry('c1', 'command', 'nff-ota list_devices', 12), entry('c2', 'command', 'nff-ota get_deployment_status', 32)],
    });
    expect(turns.map((x) => x.prompt)).toEqual(['first', 'second']);
    expect(turns[0].parts.filter((p) => p.kind === 'tool').map((p) => p.id)).toEqual(['c1']);
    expect(turns[1].parts.filter((p) => p.kind === 'tool').map((p) => p.id)).toEqual(['c2']);
  });

  it('puts activity older than the oldest prompt in a leading orphan turn', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'hello', 50)],
      entries: [entry('c0', 'command', 'ToolSearch', 5)],
    });
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBeNull();
    expect(turns[0].id).toBe('orphan');
    expect(turns[0].at.getTime()).toBe(t(5).getTime());
    expect(turns[1].prompt).toBe('hello');
  });

  it('emits no orphan turn when nothing predates the first prompt', () => {
    const turns = buildTurns({ ...base, messages: [msg('u1', 'user', 'hi', 10)] });
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('hi');
  });

  it('orders a turn by timestamp across all three sources', () => {
    const turns = buildTurns({
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', 'prose', 30)],
      entries: [entry('c1', 'command', 'Read', 15)],
      files: [{ id: 'f1', path: 'a.ts', before: 'x', content: 'y', timestamp: t(20) }],
    });
    expect(turns[0].parts.map((p) => p.kind)).toEqual(['tool', 'file', 'text']);
  });
});

describe('buildTurns — tool rows', () => {
  it('attaches output to the open command and settles it ok', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', 'ok', 90)],
      entries: [entry('c1', 'command', 'nff-ota list_devices --group prod', 12), entry('o1', 'output', 'line one', 13), entry('o2', 'output', 'line two', 14)],
    });
    const tool = turns[0].parts.find((p) => p.kind === 'tool');
    expect(tool).toMatchObject({ server: 'nff-ota', tool: 'list_devices', status: 'ok', output: 'line one\nline two' });
    expect(tool?.kind === 'tool' && tool.params).toEqual([{ name: 'group', value: 'prod' }]);
  });

  it('starts a new row at the next command and marks a failed one error', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', 'ok', 90)],
      entries: [
        entry('c1', 'command', 'Read', 12), entry('e1', 'error', 'ENOENT', 13),
        entry('c2', 'command', 'Write', 14), entry('o1', 'output', 'wrote', 15),
      ],
    });
    const tools = turns[0].parts.filter((p) => p.kind === 'tool');
    expect(tools.map((p) => p.kind === 'tool' && p.status)).toEqual(['error', 'ok']);
    expect(tools[0].kind === 'tool' && tools[0].output).toBe('ENOENT');
  });

  it('keeps the tail row running while the agent still owes a reply', () => {
    const busy = buildTurns({ ...base, messages: [msg('u1', 'user', 'go', 10)], entries: [entry('c1', 'command', 'Read', 12)] });
    expect(busy[0].busy).toBe(true);
    expect(busy[0].parts[0].kind === 'tool' && busy[0].parts[0].status).toBe('running');

    const settled = buildTurns({ ...base, messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', 'done', 20)], entries: [entry('c1', 'command', 'Read', 12)] });
    expect(settled[0].busy).toBe(false);
    expect(settled[0].parts[0].kind === 'tool' && settled[0].parts[0].status).toBe('ok');
  });

  it('flags an edit entry and falls back to the raw line when the command does not parse', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', 'ok', 90)],
      entries: [entry('c1', 'edit', 'wrote src/main.cpp', 12)],
    });
    expect(turns[0].parts[0]).toMatchObject({ kind: 'tool', edit: true, tool: 'wrote src/main.cpp' });
  });

  it('surfaces an error with no open command as its own part', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', 'ok', 90)],
      entries: [entry('e1', 'error', 'worker crashed', 12)],
    });
    expect(turns[0].parts[0]).toMatchObject({ kind: 'error', text: 'worker crashed' });
  });
});

describe('buildTurns — message classification', () => {
  it('maps each worker sentinel to its status variant', () => {
    const turns = buildTurns({
      ...base,
      messages: [
        msg('u1', 'user', 'go', 10),
        msg('a1', 'agent', '⏰ parked the follow-up', 20),
        msg('a2', 'agent', '⏹ Stopped by user.', 30),
      ],
    });
    expect(turns[0].parts).toEqual([
      { kind: 'status', id: 'a1', text: 'parked the follow-up', variant: 'schedule' },
      { kind: 'status', id: 'a2', text: 'Stopped by user.', variant: 'stopped' },
    ]);
  });

  it('keeps only the last narration line in a turn', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', '⚙ reading', 20), msg('a2', 'agent', '⚙ writing', 30), msg('a3', 'agent', 'done', 40)],
    });
    expect(turns[0].parts).toEqual([
      { kind: 'status', id: 'a2', text: 'writing', variant: 'narration' },
      { kind: 'text', id: 'a3', text: 'done' },
    ]);
  });

  it('splits an nff-choices fence out of the surrounding prose', () => {
    const content = 'Pick one:\n\n```nff-choices\n[{"label":"A","detail":"first"},{"label":"B"}]\n```\n\nthen we continue';
    const turns = buildTurns({ ...base, messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', content, 20)] });
    expect(turns[0].parts.map((p) => p.kind)).toEqual(['text', 'choices', 'text']);
    const choices = turns[0].parts[1];
    expect(choices.kind === 'choices' && choices.options).toEqual([{ label: 'A', detail: 'first' }, { label: 'B', detail: undefined }]);
  });

  it('appends live streaming text to the open turn only', () => {
    const turns = buildTurns({ ...base, messages: [msg('u1', 'user', 'a', 10), msg('a1', 'agent', 'done', 20), msg('u2', 'user', 'b', 30)], liveText: 'thinking…' });
    expect(turns[0].parts.some((p) => p.kind === 'text' && p.streaming)).toBe(false);
    expect(turns[1].parts).toEqual([{ kind: 'text', id: 'live', text: 'thinking…', streaming: true }]);
  });

  // The worker writes `⚙` narration rows DURING a run, which makes the newest
  // message an agent row. Gating the live draft on "the agent owes a reply" alone
  // blanked the streaming text exactly when work started.
  it('keeps streaming while a narration row is the newest message', () => {
    const turns = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'go', 10), msg('a1', 'agent', '⚙ resolving the group', 20)],
      entries: [entry('c1', 'command', 'nff-ota create_deployment', 22)],
      liveText: 'Queued the deployment',
    });
    const turn = turns[0];
    expect(turn.busy).toBe(true);
    expect(turn.parts.at(-1)).toEqual({ kind: 'text', id: 'live', text: 'Queued the deployment', streaming: true });
    // …and the in-flight tool row keeps shimmering rather than settling to ok.
    expect(turn.parts.find((p) => p.kind === 'tool')).toMatchObject({ status: 'running' });
  });
});

describe('jobsOnly / hasRunningJob — the console is a tool log, not a chat', () => {
  it('keeps MCP calls, edits, files and errors; drops prose, status, harness tools and emptied turns', () => {
    const turns = buildTurns({
      messages: [
        msg('u1', 'user', 'just chat', 10), msg('a1', 'agent', 'sure, here is prose', 12),
        msg('u2', 'user', 'flash it', 20), msg('a2', 'agent', '⚙ reading the sketch', 21),
      ],
      entries: [
        entry('h1', 'command', 'ToolSearch --query flash', 22),
        entry('c1', 'command', 'nff-ota get_firmware_source --device-id d1', 23),
        entry('o1', 'output', '{"ok":true}', 24),
        entry('e1', 'edit', 'nff edit [firmware.ino] (+3 −1)', 25),
        entry('x1', 'error', 'boom', 26),
      ],
      files: [{ id: 'f1', path: 'firmware.ino', before: 'a', content: 'b', timestamp: t(27) }],
    });
    const jobs = jobsOnly(turns);
    expect(jobs).toHaveLength(1); // the prose-only first turn is gone
    expect(jobs[0].id).toBe('u2');
    expect(jobs[0].parts.map((p) => `${p.kind}:${p.id}`)).toEqual(['tool:c1', 'tool:e1', 'file:f1']);
    // `error` rows that follow an open tool row fold INTO it, so x1 is c1's failure, not a part.
    expect(jobs[0].parts.find((p) => p.id === 'e1')).toMatchObject({ kind: 'tool', status: 'error' });
  });

  it('reports a running job only while a live turn has an open tool row', () => {
    const live = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'list devices', 10)],
      entries: [entry('c1', 'command', 'nff-fleet fleet_list_devices', 11)],
    });
    expect(hasRunningJob(jobsOnly(live))).toBe(true);

    const settled = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'list devices', 10), msg('a1', 'agent', '2 devices', 15)],
      entries: [entry('c1', 'command', 'nff-fleet fleet_list_devices', 11), entry('o1', 'output', '[…]', 12)],
    });
    expect(hasRunningJob(jobsOnly(settled))).toBe(false);

    // A harness tool alone never counts — it is filtered out before the check.
    const harness = buildTurns({
      ...base,
      messages: [msg('u1', 'user', 'think', 10)],
      entries: [entry('h1', 'command', 'ToolSearch --query x', 11)],
    });
    expect(hasRunningJob(jobsOnly(harness))).toBe(false);
  });
});
