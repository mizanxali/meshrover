// SPDX-License-Identifier: AGPL-3.0-only
// The warehouse's geometry on the map (map.ts), and the rover's forward camera
// frame at a checkpoint (signs and obstacles drawn large for the vision model).
import { createCanvas } from '@napi-rs/canvas';
import type { Action } from '../protocol.ts';
import { EDGES, NODES, PALLETS } from './map.ts';

export { EDGES, NODES, PALLETS };
export const STOP_DISTANCE = 1.5; // the motion loop halts this far short of a pallet

const at = (id: string) => NODES[id] ?? (() => { throw new Error(`no node ${id}`); })();
export const neighbors = (id: string) => EDGES.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
export const isJunction = (id: string) => neighbors(id).length > 2;

/** Compass heading in degrees (0 north, 90 east) from node a to node b. */
export function headingTo(a: string, b: string) {
  const [ax, ay] = at(a), [bx, by] = at(b);
  return (Math.round((Math.atan2(bx - ax, ay - by) * 180) / Math.PI) + 360) % 360;
}

/** At a corner (two aisles), the way on; at a junction, null: it needs a decision. */
export const nextAlong = (from: string, node: string) => (isJunction(node) ? null : neighbors(node).find((n) => n !== from)!);

const TURNS: Record<number, Action> = { 0: 'proceed', 270: 'turn_left', 90: 'turn_right' };

/** The aisles leaving a junction, by the action that takes each one, for a rover facing `heading`. */
export function exits(node: string, heading: number) {
  const out: Partial<Record<Action, string>> = {};
  for (const n of neighbors(node)) {
    const a = TURNS[(headingTo(node, n) - heading + 360) % 360];
    if (a) out[a] = n;
  }
  return out;
}

/** Is a pallet within `range` metres ahead of (x, y) along `heading`? */
export function palletAhead(x: number, y: number, heading: number, range: number) {
  const ux = Math.sin((heading * Math.PI) / 180), uy = -Math.cos((heading * Math.PI) / 180);
  return PALLETS.some(([px, py]) => {
    const along = (px - x) * ux + (py - y) * uy;
    const across = Math.abs((px - x) * uy - (py - y) * ux);
    return across < 0.5 && along > 0 && along <= range;
  });
}

const blocked = (a: string, b: string) => {
  const [ax, ay] = at(a), [bx, by] = at(b);
  return palletAhead(ax, ay, headingTo(a, b), Math.hypot(bx - ax, by - ay));
};

type Side = 'open' | 'pallet' | 'shelving';
/** What the camera sees at a checkpoint, and the options offered to 0G there. */
export type View = { checkpoint: string; options: Action[]; left: Side; ahead: Side; right: Side };

export function junctionView(node: string, heading: number): View {
  const ex = exits(node, heading);
  const side = (a: Action): Side => (ex[a] ? (blocked(node, ex[a]) ? 'pallet' : 'open') : 'shelving');
  const options = (['proceed', 'turn_left', 'turn_right'] as const).filter((a) => ex[a]);
  return { checkpoint: node, options: [...options, 'stop'], left: side('turn_left'), ahead: side('proceed'), right: side('turn_right') };
}

export const palletView = (from: string, to: string): View =>
  ({ checkpoint: `${from}-${to}`, options: ['turn_around', 'stop'], left: 'shelving', ahead: 'pallet', right: 'shelving' });

/** A 320×240 JPEG (quality 60), base64: about 5 KB, well under the mesh's 64 KiB body cap. */
export function renderFrame(v: View): string {
  const c = createCanvas(320, 240);
  const g = c.getContext('2d');
  g.fillStyle = '#3a3a3a'; g.fillRect(0, 0, 320, 110);
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 110, 320, 130);
  const regions: [Side, number, number, string][] = [[v.left, 0, 90, 'LEFT'], [v.ahead, 95, 130, 'AHEAD'], [v.right, 230, 90, 'RIGHT']];
  for (const [side, x, w, label] of regions) {
    if (side === 'shelving') {
      g.fillStyle = '#c2691f'; g.fillRect(x, 40, w, 200);
      g.fillStyle = '#5c3210';
      for (let y = 70; y < 240; y += 45) g.fillRect(x, y, w, 8);
      continue;
    }
    g.fillStyle = '#151515'; g.fillRect(x + 10, 60, w - 20, 70); // the aisle's depth
    g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif'; g.fillText(label, x + w / 2 - g.measureText(label).width / 2, 225);
    if (side === 'pallet') {
      g.fillStyle = '#8b4513'; g.fillRect(x + 4, 95, w - 8, 95);
      g.fillStyle = '#ffd700'; g.font = 'bold 20px sans-serif';
      g.fillText('PALLET', x + w / 2 - g.measureText('PALLET').width / 2, 150);
    }
  }
  g.fillStyle = '#ffd400'; g.fillRect(110, 6, 100, 40);
  g.fillStyle = '#000'; g.font = 'bold 28px sans-serif';
  g.fillText(v.checkpoint, 160 - g.measureText(v.checkpoint).width / 2, 37);
  return c.toBuffer('image/jpeg', 60).toString('base64');
}
