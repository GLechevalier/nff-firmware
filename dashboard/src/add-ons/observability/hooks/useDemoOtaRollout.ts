import { useMemo } from 'react';
import { useDevices } from './useDevices';
import { useGithubConnections } from '../../github/hooks/useGithubConnections';
import { useDemoPullRequests } from '../../../hooks/useDemoPullRequests';
import { useDemoBrokeAt } from '../../../context/DeviceHealthContext';
import { babynffBreakRollout, babynffHealRollout } from '../../../data/babynffDemoGit';
import type { Deployment } from '../types/ota';
import type { OtaJob } from '../data/mockOtaJobs';

// The break demo's two deploys, derived client-side — the one that broke the fleet and the one
// that healed it. Neither is a database row (api/_selfheal.ts registers the buggy source and the
// agent heals through nff-ota's submit_firmware_fix; neither writes a deployments row), so this
// mirrors data/babynffDemoGit.ts's derived-only pattern. Gated on the bundled demo repo — a
// project with a real connected repo gets its deploys from the real deployments table.
//
// The heal deploy's timing comes from useDemoPullRequests: the newest PR numbered >= 2 is the
// agent's fix (PR #1 is the break), and its openedAt is when the fix shipped. Sourcing it there
// means the fix deploy and the fix PR can never disagree about whether/when the agent shipped.
export function useDemoOtaRollout(): { deployments: Deployment[]; jobs: OtaJob[] } {
  const { devices } = useDevices();
  const { connections } = useGithubConnections();
  const prs = useDemoPullRequests();
  const brokeAt = useDemoBrokeAt();

  const hasDemoRepo = connections.some(c => c.virtual);
  // Oldest-first from useDemoPullRequests, so the last fix PR is the newest.
  const fixWhen = useMemo(() => {
    const fixes = prs.filter(p => p.number >= 2);
    return fixes.length ? fixes[fixes.length - 1].openedAt : null;
  }, [prs]);

  return useMemo(() => {
    if (!hasDemoRepo) return { deployments: [], jobs: [] };
    const rollouts = [
      babynffBreakRollout(brokeAt, devices),
      babynffHealRollout(brokeAt, fixWhen, devices),
    ].filter((r): r is NonNullable<typeof r> => r != null);
    return {
      deployments: rollouts.map(r => r.deployment),
      jobs: rollouts.flatMap(r => r.jobs),
    };
  }, [hasDemoRepo, brokeAt, fixWhen, devices]);
}
