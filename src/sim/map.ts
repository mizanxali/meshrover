// The warehouse map, shared by the sim and the dashboard (which needs it to
// replay an episode with no sim running): aisles as a graph in metres (x east,
// y south), three junctions, pallets blocking two aisles, and restricted zone C
// (the bottom loop: e, f, g), which a rover enters only with a human's approval.

//  a(4,2)────────b(12,2)
//   │             │
//  J1(4,6)──▣───J2(12,6)──▣───J3(20,6)────e(24,6)
//   │             │             │            │
//   │           c(12,10)─────d(20,10)        │
//   │                                        │
//  g(4,14)═════════════ zone C ═══════════════f(24,14)
export const NODES: Record<string, readonly [number, number]> = {
  J1: [4, 6], J2: [12, 6], J3: [20, 6],
  a: [4, 2], b: [12, 2], c: [12, 10], d: [20, 10], e: [24, 6], f: [24, 14], g: [4, 14],
};
export const EDGES: readonly (readonly [string, string])[] = [
  ['J1', 'J2'], ['J2', 'J3'], ['J1', 'a'], ['a', 'b'], ['b', 'J2'], ['J2', 'c'],
  ['c', 'd'], ['d', 'J3'], ['J3', 'e'], ['e', 'f'], ['f', 'g'], ['g', 'J1'],
];
export const PALLETS: readonly (readonly [number, number])[] = [[6.5, 6], [14.5, 6]];
/** Restricted zones by the nodes inside them. Entering one needs an approval; leaving it doesn't. */
export const ZONES: Record<string, readonly string[]> = { C: ['e', 'f', 'g'] };
