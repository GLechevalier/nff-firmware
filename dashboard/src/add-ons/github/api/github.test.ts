import { describe, expect, it } from 'vitest';
import { signInstallState, verifyInstallState, PLATFORM_PROJECT_ID } from './github';

// The install-flow state is the only thing standing between "anyone with the callback URL" and
// "bind this GitHub installation to an arbitrary project" — so it gets the one runnable check.
describe('GitHub App install state', () => {
  const secret = 'test-secret';
  const pid = '11111111-2222-4333-8444-555555555555';

  it('round-trips a signed project id', () => {
    const state = signInstallState(pid, secret);
    expect(verifyInstallState(state, secret)).toEqual({ projectId: pid });
    expect(verifyInstallState(signInstallState(PLATFORM_PROJECT_ID, secret), secret)).toEqual({ projectId: PLATFORM_PROJECT_ID });
  });

  it('rejects a tampered project id, a wrong secret, and an expired state', () => {
    const state = signInstallState(pid, secret);
    const [, exp, mac] = state.split('.');
    const other = '99999999-2222-4333-8444-555555555555';
    expect(verifyInstallState(`${other}.${exp}.${mac}`, secret)).toHaveProperty('error');
    expect(verifyInstallState(state, 'other-secret')).toHaveProperty('error');
    expect(verifyInstallState(state, secret, Date.now() + 2 * 3600 * 1000)).toHaveProperty('error');
    expect(verifyInstallState('garbage', secret)).toHaveProperty('error');
    expect(verifyInstallState(undefined, secret)).toHaveProperty('error');
  });
});
