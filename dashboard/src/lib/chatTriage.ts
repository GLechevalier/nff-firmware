import { supabase } from './supabase';

// The chat's fast path (api/_chatTriage.ts): one Haiku call that either answers the
// message outright (no tool needed — both rows are written server-side, the worker never
// runs) or says "tools" (the user row is written server-side and the worker takes it).
//
// Null on ANY failure — network, 5xx, timeout, signed-out — and the caller then inserts
// the user row itself, exactly the pre-fast-path behaviour. Never throws.

const TIMEOUT_MS = 12_000; // a triage slower than this is worse than the worker

export interface TriageReply { id: string; content: string; ts: string }
export type TriageResult = { mode: 'tools' } | { mode: 'answer'; reply: TriageReply };

export async function triageChat(args: {
  id: string;
  question: string;
  sessionId: string;
  projectId: string;
}): Promise<TriageResult | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const resp = await fetch('/api/chat/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { ok?: boolean; mode?: string; reply?: TriageReply };
    if (!body.ok) return null;
    if (body.mode === 'answer' && body.reply?.id && body.reply.content) return { mode: 'answer', reply: body.reply };
    if (body.mode === 'tools') return { mode: 'tools' };
    return null;
  } catch {
    return null;
  }
}
