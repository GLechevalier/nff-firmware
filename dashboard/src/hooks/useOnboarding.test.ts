import { describe, expect, it } from 'vitest';
import { parseOnboardingPath } from './useOnboarding';

describe('parseOnboardingPath', () => {
  it('accepts the two paths and nothing else', () => {
    expect(parseOnboardingPath('dev-soft')).toBe('dev-soft');
    expect(parseOnboardingPath('dev-physical')).toBe('dev-physical');
    expect(parseOnboardingPath('garbage')).toBeNull();
    expect(parseOnboardingPath(null)).toBeNull();
  });
});
