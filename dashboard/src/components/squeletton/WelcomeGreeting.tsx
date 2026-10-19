import { useUser } from '../../hooks/useUser';

// Greets the signed-in user by first name (full_name → name → email local-part → "there").
// This is the whole empty state of an agent chat with no messages yet, so it fills the
// transcript area (flex: 1 inside ChatPanel's message column) and centres itself: a big
// hello and one line saying what the agent is for, rather than a stray line of text
// floating in the top-left corner of an otherwise blank panel.
export function WelcomeGreeting() {
  const { user } = useUser();
  const meta = (user?.user_metadata ?? {}) as { full_name?: string; name?: string };
  // An email local-part is the usual fallback and reads badly at display size
  // ("gauthier.lechevalier26"), so take its first dot/underscore token too.
  const raw =
    (meta.full_name || meta.name || '').trim().split(/\s+/)[0] ||
    user?.email?.split('@')[0].split(/[._-]/)[0] ||
    'there';
  const firstName = raw.charAt(0).toUpperCase() + raw.slice(1);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '24px 16px',
        textAlign: 'center',
      }}
    >
      {/* clamp: this column is half the page, and halves again when the chat list
          is open — the greeting has to stay readable at every width. */}
      <div style={{ fontSize: 'clamp(22px, 4vw, 34px)', fontWeight: 'bold', lineHeight: 1.15 }}>
        Welcome, {firstName}
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: '#666', maxWidth: '34ch' }}>
        Ask your agent anything about this workspace — it can build, flash, debug and
        deploy, and it remembers what it learns in the brain beside you.
      </div>
    </div>
  );
}
