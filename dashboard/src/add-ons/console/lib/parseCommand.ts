// Pure parsers for the device agent's console entries.
//
// Moved verbatim out of components/squeletton/ConsolePanel.tsx, which still
// imports them for the black log panel (device "Signals", Improve). The console
// transcript needs the same parse to build its tool rows, and two copies of this
// regex would drift the moment the worker's formatToolUse() changes.

/**
 * Parse a `formatToolUse()` command string — `<tool> --flag value …`, or
 * `nff-<server> <tool> --flag value …` for an MCP tool — into its tool token +
 * flag/value params. The worker JSON.stringify-quotes any value containing
 * whitespace, so quoted values are decoded back to raw text here. Returns null
 * for a string with no recognisable head, so the caller can fall back to
 * rendering the raw line.
 */
export interface ParsedCommand {
  server?: string; // leading `nff-*` MCP server token (rendered teal); absent for harness/built-in tools
  tool: string; // the tool name — a bare harness name (`ToolSearch`) or the tool after the server
  params: { flag: string; value: string }[];
}

export function parseCommand(content: string): ParsedCommand | null {
  const text = content.trim();
  if (!text) return null;
  // The head ends at the first ` --` (start of the flags); with no flags the whole string is the head.
  const flagIdx = text.search(/\s--/);
  const head = (flagIdx === -1 ? text : text.slice(0, flagIdx)).trim();
  if (!head) return null;
  const flagStr = flagIdx === -1 ? '' : text.slice(flagIdx);

  let server: string | undefined;
  let tool = head;
  const m = /^(nff-[a-z]+)\s+(.+)$/.exec(head);
  if (m) {
    server = m[1];
    tool = m[2];
  }

  // Camel-tolerant (`a-zA-Z`, unlike breadcrumb.ts) so `--delaySeconds` is captured; each value is a
  // "quoted string" (worker quotes anything with whitespace) or a spaceless bareword.
  const params: { flag: string; value: string }[] = [];
  const re = /--([a-zA-Z0-9-]+)\s+("(?:[^"\\]|\\.)*"|\S+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(flagStr)) !== null) {
    let value = mm[2];
    if (value[0] === '"') {
      try {
        value = JSON.parse(value) as string;
      } catch {
        // malformed quote — keep the raw token
      }
    }
    params.push({ flag: mm[1], value });
  }
  return { server, tool, params };
}

/**
 * If `s` is a JSON object/array, return it pretty-printed (2-space indent);
 * otherwise null. Cheap guard (first non-space char) before attempting a parse,
 * so plain-text output is untouched.
 */
export function tryJson(s: string): string | null {
  const t = s.trim();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
  } catch {
    // not JSON — fall through
  }
  return null;
}
