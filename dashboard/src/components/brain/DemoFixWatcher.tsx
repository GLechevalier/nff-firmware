import { useEffect, useRef } from 'react';
import { useFirmwareFixJob } from '../../hooks/useFirmwareFixJob';

interface Props {
  deviceId: string | null;      // the device the demo is healing (null = idle, no subscription)
  onFixFailed: (reason: string) => void;
}

// Headless. The demo's blind spot: `submit_firmware_fix` only ENQUEUES a build and returns
// status='pending', so the code stream terminating means "the agent submitted", NOT "the fix works".
// nff-ota's fix_worker compiles the real L2 firmware afterwards and records the outcome on
// firmware_fix_jobs — where nothing else in the stack ever looked. Without this, a fix that fails to
// compile is indistinguishable from one still building: the story marches on to "healthy again 🎉"
// while the dot sits red for the full 25/40-min TTL, explaining nothing.
//
// Deliberately does NOT clear the red dot on failure: a fix that never built means the device really
// is still broken, so red is the honest colour. What was missing is the reason, not a colour change.
export function DemoFixWatcher({ deviceId, onFixFailed }: Props) {
  const job = useFirmwareFixJob(deviceId);
  // Fire once per job id — the row is updated (pending→running→error), so the subscription
  // re-delivers the terminal state on every subsequent change.
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!job || job.status !== 'error' || firedRef.current === job.id) return;
    firedRef.current = job.id;
    // The compile log's tail is the real error (gcc/ninja); nff-ota already truncated it to that.
    const first = (job.error ?? '').trim().split('\n').filter(Boolean).pop() ?? 'the build failed';
    onFixFailed(first);
  }, [job, onFixFailed]);

  return null;
}
