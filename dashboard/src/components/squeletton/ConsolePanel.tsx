import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import { CodeHighlight, darkTheme } from './CodeHighlight';
import { parseCommand, tryJson } from '../../add-ons/console/lib/parseCommand';

// How many trailing lines "copy log" grabs — a bounded snapshot for pasting into a
// bug report, not the whole (possibly huge) scrollback.
const COPY_LOG_LIMIT = 100;

// The blue an `edit` line renders in. A lighter blue than the dashboard's link blue (#1d4ed8),
// which is near-unreadable on this panel's black background.
const EDIT_COLOR = '#60a5fa';

// The accent a command's leading MCP-server token (`nff-ota`, `nff-builder`, …) renders in, so the
// tool a command targets pops out of the otherwise-white command line. Teal: distinct from the
// edit blue and from CodeHighlight's JSON palette.
const SERVER_COLOR = '#4ec9b0';

// Wrapping rules shared by every text surface in the panel: soft-wrap at spaces AND break long
// unbroken tokens (URLs, base64, spaceless JSON) so nothing spills past the panel's right edge.
const WRAP = {
  whiteSpace: 'pre-wrap' as const,
  overflowWrap: 'anywhere' as const,
  wordBreak: 'break-word' as const,
};

// Render a `command` line. The tool token pops in SERVER_COLOR (an MCP tool keeps its teal `nff-*`
// server token with the tool name white; a bare harness tool like `ToolSearch` is teal itself).
// Collapsed, the params show as grey flag NAMES only, so a long `--prompt`/`--reason` value can't spill
// into the feed; expanded (Ctrl+O) each param drops to its own indented `flag  value` line in grey,
// values in full. Falls back to the raw `> …` string for anything that doesn't parse as a command.
function renderCommand(content: string, expanded: boolean) {
  const parsed = parseCommand(content);
  if (!parsed) return `> ${content}`;
  const { server, tool, params } = parsed;
  const token = (
    <>
      {server && <span style={{ color: SERVER_COLOR }}>{server} </span>}
      <span style={{ color: server ? '#fff' : SERVER_COLOR }}>{tool}</span>
    </>
  );
  if (params.length === 0) return <>{'> '}{token}</>;
  if (!expanded) {
    return (
      <>
        {'> '}
        {token}
        {'  '}
        <span style={{ color: '#888' }}>{params.map(p => p.flag).join(' ')}</span>
      </>
    );
  }
  return (
    <>
      {'> '}
      {token}
      {params.map((p, i) => (
        <div key={`${p.flag}-${i}`} style={{ ...WRAP, paddingLeft: 16 }}>
          <span style={{ color: '#888', display: 'inline-block', minWidth: '11ch', marginRight: 8 }}>{p.flag}</span>
          <span style={{ color: '#aaa' }}>{p.value}</span>
        </div>
      ))}
    </>
  );
}

export interface ConsoleEntry {
  id: string;
  // `edit` is a command that wrote source — the agent changing firmware is the one line a human
  // scans a run for, so it gets its own colour instead of hiding among the grey tool calls.
  type: 'command' | 'output' | 'error' | 'info' | 'edit';
  content: string;
  timestamp: Date;
}

interface Props {
  entries: ConsoleEntry[];
  onClear: () => void;
  // "Load older entries" pagination: render an arrow at the top when more remain.
  onLoadOlder?: () => void;
  hasMore?: boolean;
  loadingOlder?: boolean;
  // Pin the most recent command/edit in a sticky strip below the header so it stays visible
  // while its output streams below. Opt-in: the live Agent tab wants it; the telemetry
  // "Signals" / demo / floor embeds (which carry no commands) don't.
  pinLastCommand?: boolean;
  // Cross-panel hover linking (Agent tab desktop split): command/edit entry ids to paint as
  // "linked" — set by AgentTab when the correlated agent reply is hovered. Fired back when a command
  // row is hovered so the chat can ring that turn's reply. Omitted by embeds without a paired chat.
  highlightedIds?: ReadonlySet<string>;
  onHoverEntry?: (id: string | null) => void;
}

export function ConsolePanel({ entries, onClear, onLoadOlder, hasMore, loadingOlder, pinLastCommand, highlightedIds, onHoverEntry }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);

  // Tool-call params (grey flag names) and JSON tool results are collapsed by default so raw payloads
  // don't drown the log; Ctrl+O (or the header toggle) reveals every param value + JSON output in full.
  const [jsonExpanded, setJsonExpanded] = useState(false);

  // The command whose output currently sits at the top of the view — a sticky "section header".
  // Driven by scroll (see recomputeActive): as you scroll up through history, this tracks the
  // command that owns what you're reading; scrolled to the bottom it settles on the newest.
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);

  // Find the last command/edit row that has scrolled to or above the scroller's top edge — the one
  // that "owns" whatever output is at the top of the view. Falls back to the first command when the
  // list is shorter than the viewport / scrolled fully up, so the strip always names *something*.
  const recomputeActive = useCallback(() => {
    if (!pinLastCommand) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const rows = scroller.querySelectorAll<HTMLElement>('[data-command-id]');
    let activeId: string | null = null;
    for (const row of rows) {
      // A few px of slack so a header flush with the top edge counts as "reached".
      if (row.getBoundingClientRect().top - top <= 4) {
        activeId = row.dataset.commandId ?? null;
      } else {
        break; // rows are in document order — the first one below the fold ends the scan.
      }
    }
    if (activeId === null && rows.length > 0) activeId = rows[0].dataset.commandId ?? null;
    setActiveCommandId(prev => (prev === activeId ? prev : activeId));
  }, [pinLastCommand]);

  // rAF-throttle the scroll handler so fast streaming / flick-scrolling can't thrash renders.
  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recomputeActive();
    });
  }, [recomputeActive]);

  // The command that produced whatever is currently scrolling past — kept pinned so you never
  // lose track of what is running. `edit` counts (it's a command that wrote source). Prefers the
  // scroll-derived active command; before any scroll (and while live-tailing) it's the newest.
  const activeCommand = activeCommandId ? entries.find(e => e.id === activeCommandId) : undefined;
  const lastCommand = pinLastCommand
    ? (activeCommand ?? [...entries].reverse().find(e => e.type === 'command' || e.type === 'edit'))
    : undefined;

  // Copy up to the last COPY_LOG_LIMIT lines, newline-joined — a bounded snapshot for
  // pasting into a bug report. Computed lazily on click by CopyButton. Shared by the
  // agent console and the device "Signals" panel, since both render through here.
  const copyLog = () => entries.slice(-COPY_LOG_LIMIT).map(e => e.content).join('\n');

  // Whether anything collapsible is present — a JSON tool result, or a command carrying params
  // (whose values collapse to flag names). Gates the single Ctrl+O/Esc footer hint.
  const hasCollapsible = entries.some(e =>
    (e.type === 'output' && tryJson(e.content) !== null) ||
    (e.type === 'command' && (parseCommand(e.content)?.params.length ?? 0) > 0),
  );

  useEffect(() => {
    // Auto-scroll to the bottom only when a NEW entry lands at the end or on first
    // load — not when older entries are prepended via "load older", which would
    // otherwise yank the view away from where the user is.
    const lastId = entries[entries.length - 1]?.id ?? null;
    if (lastId === lastIdRef.current) return;
    lastIdRef.current = lastId;
    const scroller = bottomRef.current?.parentElement;
    if (!scroller) return;
    // Defer one frame so the just-appended (pre-wrap, multi-line) row is laid out
    // before we read scrollHeight — a synchronous measure lands short and leaves the
    // newest lines below the fold during the self-heal demo's rapid streaming.
    const raf = requestAnimationFrame(() => {
      // Scroll the panel's own container, not via scrollIntoView — the latter also
      // scrolls every scrollable ancestor (and across an iframe boundary into the
      // host page), which jerks the page when this panel is embedded.
      scroller.scrollTop = scroller.scrollHeight;
      // Keep the "Last command" strip correct as content streams in / older rows prepend.
      recomputeActive();
    });
    return () => cancelAnimationFrame(raf);
  }, [entries, recomputeActive]);

  // Cancel any pending scroll rAF on unmount.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Ctrl+O (⌘O on macOS) toggles full JSON output — preventDefault stops the browser's Open-file
  // dialog. Once expanded, Esc is the way back (collapse). Every mounted console listens, so the
  // toggle flips them all at once. jsonExpanded is in deps so the Esc branch reads it fresh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setJsonExpanded(v => !v);
      } else if (e.key === 'Escape' && jsonExpanded) {
        setJsonExpanded(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [jsonExpanded]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ borderBottom: '1px solid #444', padding: '4px 8px', fontSize: 12, display: 'flex', justifyContent: 'space-between', background: '#000', color: '#fff' }}>
        <span>Console</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => setJsonExpanded(v => !v)}
            title="Expand tool-call args & JSON output (Ctrl+O)"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0, color: '#aaa' }}
          >
            Detail {jsonExpanded ? '▾' : '▸'}
          </button>
          {entries.length > 0 && (
            <CopyButton variant="icon" dark title={`Copy the last ${COPY_LOG_LIMIT} lines`} value={copyLog} />
          )}
          <button
            onClick={onClear}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', padding: 0, color: '#aaa' }}
          >
            clear
          </button>
        </div>
      </div>
      {lastCommand && (
        <div style={{ borderBottom: '1px solid #333', padding: '5px 8px', background: '#111', fontSize: 12, lineHeight: 1.4 }}>
          <div style={{ color: '#666', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 2 }}>Last command</div>
          <div
            style={{
              ...WRAP,
              color: lastCommand.type === 'edit' ? EDIT_COLOR : '#fff',
              fontWeight: lastCommand.type === 'edit' ? 'bold' : 'normal',
              // Cap a huge command to ~2 lines so it can't swallow the pane.
              display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
              overflow: 'hidden', maxHeight: '2.8em',
            }}
          >
            {lastCommand.type === 'edit' ? `✎ ${lastCommand.content}` : renderCommand(lastCommand.content, jsonExpanded)}
          </div>
        </div>
      )}
      <div ref={scrollerRef} onScroll={pinLastCommand ? onScroll : undefined} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px', fontSize: 13, lineHeight: 1.5, background: '#000' }}>
        {hasMore && onLoadOlder && (
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <button
              onClick={onLoadOlder}
              disabled={loadingOlder}
              style={{
                background: 'none', border: '1px solid #444', color: '#aaa',
                fontSize: 11, padding: '2px 10px',
                cursor: loadingOlder ? 'default' : 'pointer', letterSpacing: 0.3,
              }}
            >
              {loadingOlder ? 'Loading…' : '↑ Load older entries'}
            </button>
          </div>
        )}
        {entries.length === 0 && (
          <span style={{ color: '#555' }}>Waiting for commands…</span>
        )}
        {entries.map(entry => {
          // A JSON tool result renders pretty-printed + highlighted when expanded; otherwise it
          // collapses to a one-line placeholder so raw payloads don't drown the log.
          const json = entry.type === 'output' ? tryJson(entry.content) : null;
          if (json) {
            if (!jsonExpanded) {
              return (
                <div
                  key={entry.id}
                  onClick={() => setJsonExpanded(true)}
                  title="Ctrl+O to expand JSON output"
                  style={{ ...WRAP, color: '#666', fontStyle: 'italic', cursor: 'pointer' }}
                >
                  {'{…} JSON output'}
                </div>
              );
            }
            return (
              <CodeHighlight
                key={entry.id}
                code={json}
                language="json"
                theme={darkTheme}
                style={{ ...WRAP, margin: 0, fontSize: 13, lineHeight: 1.5 }}
              />
            );
          }
          const isCommand = entry.type === 'command' || entry.type === 'edit';
          // Only command/edit rows link to a chat reply; hovering one rings its turn's bubble, and
          // a reverse-linked command gets a layout-neutral inset accent (no border shift).
          const isLinked = isCommand && (highlightedIds?.has(entry.id) ?? false);
          return (
            <div
              key={entry.id}
              // Marker the scroll handler reads to find the command that owns the top-visible output.
              data-command-id={isCommand ? entry.id : undefined}
              onMouseEnter={isCommand ? () => onHoverEntry?.(entry.id) : undefined}
              onMouseLeave={isCommand ? () => onHoverEntry?.(null) : undefined}
              style={{
                ...WRAP,
                marginBottom: entry.type === 'info' ? 2 : 0,
                fontStyle: entry.type === 'error' ? 'italic' : 'normal',
                color: entry.type === 'info'    ? '#fff'
                     : entry.type === 'edit'    ? EDIT_COLOR
                     : entry.type === 'command' ? '#fff'
                     : entry.type === 'error'   ? '#555'
                     : '#888',
                fontWeight: entry.type === 'edit' ? 'bold' : 'normal',
                background: isLinked ? 'rgba(78,201,176,0.12)' : undefined,
                boxShadow: isLinked ? 'inset 2px 0 0 #4ec9b0' : undefined,
              }}
            >
              {entry.type === 'command' ? renderCommand(entry.content, jsonExpanded)
             : entry.type === 'info'    ? `# ${entry.content}`
             : entry.type === 'edit'    ? `✎ ${entry.content}`
             : entry.content}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {hasCollapsible && (
        <div style={{ borderTop: '1px solid #333', padding: '4px 8px', background: '#000', fontSize: 11, color: '#666' }}>
          {jsonExpanded ? 'Esc · collapse details' : 'Ctrl+O · expand details'}
        </div>
      )}
    </div>
  );
}
