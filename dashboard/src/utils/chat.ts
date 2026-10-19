// Helpers for displaying chat messages.

// Marker that separates an injected context preamble from the user's actual
// question. QueryPopup prepends a device-context preamble to its first message
// (so the stateless `claude -p` per turn has the device in view) and joins it to
// the typed question with this marker. The History tab reads the raw stored
// `content`, so it must strip everything up to and including this marker to avoid
// showing the engineered preamble (which reads like a system prompt) to the user.
// QueryPopup.buildAgentMessage imports this constant so the two never drift.
export const USER_QUESTION_MARKER = '\n\nUser question: ';

/**
 * For display, return only the user's actual question from a stored user message.
 * If `content` carries an injected context preamble (…preamble…<MARKER><question>),
 * drop everything up to and including the marker; otherwise return it unchanged.
 */
export function stripContextPreamble(content: string): string {
  const idx = content.indexOf(USER_QUESTION_MARKER);
  return idx === -1 ? content : content.slice(idx + USER_QUESTION_MARKER.length);
}
