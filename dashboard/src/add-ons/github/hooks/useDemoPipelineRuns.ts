import { useMemo } from 'react';
import { useGithubConnections } from './useGithubConnections';
import { useDemoPullRequests } from '../../../hooks/useDemoPullRequests';
import { useDemoBrokeAt, useDemoBrokenNow } from '../../../context/DeviceHealthContext';
import { babynffDemoPipelineRuns } from '../../../data/babynffDemoGit';
import type { PipelineRun } from '../types/github';

// The break-and-heal demo's two beats, as pipeline runs for GithubTab's "Deploys" panel: the deploy
// that shipped the bad commit and broke the fleet, and the deploy(s) that carried the agent's fix.
// Neither is a pipeline_runs row (api/_selfheal.ts registers the buggy source and the agent heals
// through nff-ota's submit_firmware_fix; neither writes pipeline_runs), so this mirrors the
// derived-only pattern of useDemoOtaRollout / useDemoPullRequests. Gated on the bundled demo repo —
// a project with a real connected repo gets its deploys from the pipeline_runs table.
//
// The fix runs' identity and timing come from useDemoPullRequests (PR #1 is the break, #2+ are the
// agent's fixes), so the Deploys list, the PRs, and the commit spine can never disagree about
// whether/when the agent shipped.
export function useDemoPipelineRuns(): PipelineRun[] {
  const { connections } = useGithubConnections();
  const prs = useDemoPullRequests();
  const brokeAt = useDemoBrokeAt();
  const brokenNow = useDemoBrokenNow();

  const demoConn = connections.find(c => c.virtual) ?? null;

  return useMemo(() => {
    if (!demoConn) return [];
    // Oldest-first from useDemoPullRequests; drop the break (PR #1) and keep the agent's fixes.
    const fixes = prs.filter(p => p.number >= 2).map(p => ({ runId: p.runId, when: p.openedAt }));
    return babynffDemoPipelineRuns({ brokeAt, brokenNow, connectionId: demoConn.id, fixes });
  }, [demoConn, prs, brokeAt, brokenNow]);
}
