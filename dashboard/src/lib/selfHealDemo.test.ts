import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '../types/device';
import { pickVictim, waitForVictim } from './selfHealDemo';

function mock(id: string, deviceType: string, status: Device['status']): Device {
  return { id, deviceType, status } as Device;
}

const L1 = mock('mock-aaaa-1', 'esp32', 'online');
const L2_BOOTING = mock('mock-aaaa-2', 'nff-qemu-esp32', 'offline');
const L2 = mock('mock-aaaa-2', 'nff-qemu-esp32', 'online');

describe('pickVictim', () => {
  it('only takes an online/warning L2 mock — never an L1', () => {
    expect(pickVictim([L1, L2_BOOTING])).toBeUndefined();
    expect(pickVictim([L1, L2])).toBe(L2);
  });
});

describe('waitForVictim', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves once the device list gains an online L2', async () => {
    let devices = [L1, L2_BOOTING];
    const p = waitForVictim(() => devices, 10_000, 1_000);
    await vi.advanceTimersByTimeAsync(2_500);
    devices = [L1, L2];
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe(L2);
  });

  it('gives up past the timeout', async () => {
    const p = waitForVictim(() => [L1], 3_000, 1_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(p).resolves.toBeUndefined();
  });
});
