import { describe, expect, it } from 'vitest';
import { frameView } from './usePanZoom';

const o = { padding: 56, minScale: 0.15, maxScale: 2.5 };
const box = { minX: -100, minY: -50, maxX: 900, maxY: 650 };
const board = (v: { tx: number; ty: number; scale: number }, x: number, y: number) =>
  ({ x: v.tx + x * v.scale, y: v.ty + y * v.scale });

describe('frameView', () => {
  it('without focus centres the bbox and fits it inside the padding', () => {
    const v = frameView(box, 800, 600, o);
    expect(board(v, 400, 300)).toEqual({ x: 400, y: 300 });
    expect(board(v, box.minX, box.minY).x).toBeGreaterThanOrEqual(56);
    expect(board(v, box.maxX, box.maxY).y).toBeLessThanOrEqual(600 - 56);
  });

  it('with focus puts the focus at the exact panel centre and keeps the whole box in view', () => {
    const focus = { x: 700, y: 100 }; // off-centre hub: the far (left/bottom) side must set the scale
    const v = frameView({ ...box, focus }, 800, 600, o);
    const c = board(v, focus.x, focus.y);
    expect(c.x).toBeCloseTo(400);
    expect(c.y).toBeCloseTo(300);
    const tl = board(v, box.minX, box.minY);
    const br = board(v, box.maxX, box.maxY);
    expect(tl.x).toBeGreaterThanOrEqual(56 - 1e-9);
    expect(tl.y).toBeGreaterThanOrEqual(56 - 1e-9);
    expect(br.x).toBeLessThanOrEqual(800 - 56 + 1e-9);
    expect(br.y).toBeLessThanOrEqual(600 - 56 + 1e-9);
  });

  it('clamps the scale to the configured range', () => {
    expect(frameView({ minX: 0, minY: 0, maxX: 10, maxY: 10, focus: { x: 5, y: 5 } }, 800, 600, o).scale).toBe(2.5);
    expect(frameView({ minX: 0, minY: 0, maxX: 1e6, maxY: 1e6, focus: { x: 0, y: 0 } }, 800, 600, o).scale).toBe(0.15);
  });
});
