import { useState } from 'react';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useGithubConnections } from '../hooks/useGithubConnections';
import { dashboardGithubApi } from '../lib/githubApi';

// GitHub add-on — "connect GitHub" card. GitHub has no Store settings tab, so before this the
// only way in was the Dev → GitHub tab; the seed hub's GitHub node needed a card it
// could render beside the graph.
//
// Connecting is a GitHub App install, not an OAuth grant: the server signs the install
// URL's state with the project id and GitHub bounces back through /api/github/installed.
// Picking WHICH repo deploys to which device group stays in ConnectGithubModal on the
// Dev → GitHub tab — this card only gets the App onto the account.
export function GithubConnect() {
  const { currentProjectId } = useCurrentProject();
  const { connections } = useGithubConnections();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The demo repo is injected client-side, not connected — it must not read as connected.
  const repos = connections.filter((c) => !c.virtual);

  async function connect() {
    if (!currentProjectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await dashboardGithubApi.get<{ url: string }>(
        `/install-url?project_id=${encodeURIComponent(currentProjectId)}`,
      );
      window.location.assign(r.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-sm font-bold tracking-label text-ink">GitHub</h2>
      <p className="mt-1 text-xs text-muted">
        Install the nff GitHub App on your account or org so your repos, branches, pipeline runs and
        firmware builds become nodes in your brain. Pushing to a repo&apos;s production branch then builds
        its firmware and rolls it out — there is no CI to configure.
      </p>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 text-xs">
        {repos.length > 0 && (
          <p className="mb-2 text-green-600">
            Connected: {repos.map((c) => c.repoFullName).join(', ')}
          </p>
        )}
        <button
          onClick={() => void connect()}
          disabled={busy || !currentProjectId}
          className="border border-ink bg-ink px-3 py-1.5 text-xs font-bold text-paper disabled:opacity-50"
        >
          {busy ? 'Opening GitHub…' : repos.length > 0 ? 'Add another account' : 'Connect GitHub'}
        </button>
      </div>

      <p className="mt-2 text-xs text-faint">
        You choose which repositories the App can see on GitHub&apos;s own install screen. Point a repo at a
        device group afterwards from Dev → GitHub.
      </p>
    </div>
  );
}
