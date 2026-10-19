// Parses an optional ```nff-choices``` fenced block out of an agent message. The agent
// emits it when it wants the user to pick between options (e.g. architecture choices); the
// dashboard then renders an arrow-navigable selector (ChoiceSelector) instead of plain text.
//
// Shape inside the fence is a JSON array: [{ "label": "...", "detail": "..." }, ...]
// Anything before/after the fence is still rendered as markdown. If the block is missing or
// malformed, `choices` is null and the original content renders unchanged (full backward-compat).

export interface Choice {
  label: string;
  detail?: string;
}

export interface ParsedChoices {
  before: string;
  choices: Choice[] | null;
  after: string;
}

// Matches a fenced block opened with ```nff-choices (optionally with surrounding whitespace).
const FENCE_RE = /```[ \t]*nff-choices[ \t]*\r?\n([\s\S]*?)```/;

export function parseChoices(content: string): ParsedChoices {
  const m = FENCE_RE.exec(content);
  if (!m) return { before: content, choices: null, after: '' };

  let choices: Choice[] | null = null;
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) {
      const cleaned = parsed
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map(c => ({ label: c.label, detail: c.detail }))
        .filter(c => typeof c.label === 'string' && c.label.trim().length > 0)
        .map(c => ({ label: String(c.label), detail: typeof c.detail === 'string' ? c.detail : undefined }));
      if (cleaned.length > 0) choices = cleaned;
    }
  } catch {
    choices = null;
  }

  if (!choices) return { before: content, choices: null, after: '' };

  return {
    before: content.slice(0, m.index).trimEnd(),
    choices,
    after: content.slice(m.index + m[0].length).trimStart(),
  };
}
