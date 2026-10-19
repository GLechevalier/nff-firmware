// chime — tiny synthesized notification sounds (Web Audio oscillator, no
// binary assets). Used by FeatureToasts so a finished build is audible while
// the admin is on another tab. AudioContext is created lazily and resumed on
// each play: browsers keep it suspended until the page has had a user gesture,
// so the first chime after a cold load with zero interaction silently no-ops.

let ctx: AudioContext | null = null;

function note(ac: AudioContext, freq: number, at: number, dur: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.15, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur);
}

export function playChime(kind: 'success' | 'error') {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    if (kind === 'success') {
      note(ctx, 660, t, 0.15);
      note(ctx, 880, t + 0.13, 0.25);
    } else {
      note(ctx, 330, t, 0.18);
      note(ctx, 220, t + 0.16, 0.3);
    }
  } catch {
    // audio must never break the toast path
  }
}
