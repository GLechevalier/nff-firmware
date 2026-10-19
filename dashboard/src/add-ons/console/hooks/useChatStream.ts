import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';

// Live assistant text, straight off the worker's broadcast.
//
// src/core/agent/service/src/roles/agent/chatStream.ts has been broadcasting these
// frames on `chat-stream:<projectId>` all along and nothing subscribed. Modelled
// on src/hooks/useCodeStream.ts, which consumes the sibling `code-stream:` channel.
//
// Frame contract (chatStream.ts createChatStreamTracker):
//   delta {runId, sessionId, block, text}  text is CUMULATIVE for that block —
//                                          assign, never concatenate. (code-stream's
//                                          `reasoning` frames are incremental; do not
//                                          copy that line from useCodeStream.)
//   clear {runId, sessionId, block}        the block's real agent_messages row landed;
//                                          retire the draft so it does not double up.
//   done  {runId, sessionId}               run settled.
//
// This is a cosmetic nudge only: every character also arrives as a real
// `agent_messages` row over postgres_changes (plus ChatPanel's refetchNewer
// backstop). Losing a frame costs a smooth reveal, never content — which is why
// there is no poll here, unlike the request-row waits in adminChat.ts.

interface Frame {
  runId?: string;
  sessionId?: string | null;
  block?: number;
  text?: string;
}

// A draft with no frame for this long is a dead run (worker crashed mid-stream
// without sending `done`). Drop it rather than leave a ghost caret blinking.
const STALE_MS = 120_000;

export function useChatStream(sessionId: string | null | undefined): string {
  const { currentProjectId } = useCurrentProject();
  // Drafts are tagged with the thread they belong to and read back as empty when
  // the tag is stale, so switching project or session clears them in the SAME
  // render rather than via a setState in an effect (the pattern DiffView.tsx uses).
  const key = `${currentProjectId ?? ''}:${sessionId ?? ''}`;
  const [state, setState] = useState<{ key: string; blocks: Record<number, string> }>({ key, blocks: {} });
  const blocks = state.key === key ? state.blocks : {};
  const [touched, setTouched] = useState(0);

  const setBlocks = useCallback(
    (fn: (prev: Record<number, string>) => Record<number, string>) =>
      setState((s) => ({ key, blocks: fn(s.key === key ? s.blocks : {}) })),
    [key],
  );

  useEffect(() => {
    if (!currentProjectId || sessionId === undefined) return;

    const mine = (f: Frame) => sessionId === null || !f.sessionId || f.sessionId === sessionId;

    const channel = supabase.channel(`chat-stream:${currentProjectId}`);
    channel.on('broadcast', { event: 'delta' }, (msg) => {
      const f = (msg.payload ?? {}) as Frame;
      if (!mine(f) || typeof f.block !== 'number' || typeof f.text !== 'string') return;
      setBlocks((prev) => (prev[f.block!] === f.text ? prev : { ...prev, [f.block!]: f.text! }));
      setTouched(Date.now());
    });
    channel.on('broadcast', { event: 'clear' }, (msg) => {
      const f = (msg.payload ?? {}) as Frame;
      if (!mine(f) || typeof f.block !== 'number') return;
      setBlocks((prev) => {
        if (!(f.block! in prev)) return prev;
        const next = { ...prev };
        delete next[f.block!];
        return next;
      });
    });
    channel.on('broadcast', { event: 'done' }, (msg) => {
      if (mine((msg.payload ?? {}) as Frame)) setBlocks(() => ({}));
    });
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentProjectId, sessionId, setBlocks]);

  // Drop a draft the worker stopped feeding.
  useEffect(() => {
    if (!touched) return;
    const id = setTimeout(() => setBlocks(() => ({})), STALE_MS);
    return () => clearTimeout(id);
  }, [touched, setBlocks]);

  return Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((b) => blocks[b])
    .join('\n\n');
}
