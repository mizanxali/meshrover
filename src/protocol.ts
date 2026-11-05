// SPDX-License-Identifier: AGPL-3.0-only
// Message types shared by the base and the rovers, and the pure checks the
// safe-stop rules depend on. Anything these checks reject leaves the rover in
// SAFE_STOPPED: there is no default action and no fallback decision.

export const ACTIONS = ['proceed', 'turn_left', 'turn_right', 'turn_around', 'stop'] as const;
export type Action = (typeof ACTIONS)[number];

// 0G decisions measured p50 about 3.0 s, p95 about 4.0 s, slowest 5.75 s.
export const BASE_TIMEOUT_MS = 6000;
export const ROVER_DEADLINE_MS = 6500;
export const MAX_BODY = 64 * 1024; // the mesh's service body cap

export type Pose = { x: number; y: number; heading: number };

/** Rover → base, service `fleet.decide`, method `decide`. */
export type DecideRequest = {
  v: 1;
  robot: string;
  episode: string;
  seq: number;
  checkpoint: string;
  options: Action[];
  pose: Pose;
  battery: number;
  frame_jpeg_b64: string;
};

/** Base → rover, status `ok`. */
export type DecideResponse = {
  v: 1;
  seq: number;
  action: Action;
  reason: string;
  model: string;
  request_id: string;
  tee_verified: true;
  verifiability: string; // the model's TEE tier, in words: what tee_verified actually attests
};

/** Base → rover, status `error`: never a decision, it only explains the stop. */
export type DecideError = { v: 1; seq: number; error: string };

/** What a rover is waiting on: one seq, the options it offered, its own deadline. */
export type Pending = { seq: number; options: readonly Action[]; deadline: number; provider: string };

export type Verdict = { ok: true; decision: DecideResponse } | { ok: false; reason: string };

const isObj = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o);
const isAction = (a: unknown): a is Action => ACTIONS.includes(a as Action);
const shortStr = (s: unknown, max = 64): s is string => typeof s === 'string' && s.length > 0 && s.length <= max;
const json = (s: unknown): unknown => {
  if (typeof s !== 'string') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The model's reply text → an offered action, or null. Accepts a code fence around the JSON. */
export function parseDecision(content: unknown, options: readonly Action[]): { action: Action; reason: string } | null {
  if (typeof content !== 'string') return null;
  const o = json(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!isObj(o) || !isAction(o.action) || !options.includes(o.action)) return null;
  if (o.reason !== undefined && typeof o.reason !== 'string') return null;
  return { action: o.action, reason: (o.reason ?? '').slice(0, 200) };
}

/**
 * A `service_response_received` event → the decision it carries, if it answers
 * the pending seq, from the base, sealed, before the deadline, with an offered
 * action and a TEE-verified 0G request ID. Anything else is not a decision.
 */
export function acceptDecision(pending: Pending | null, event: unknown, now: number): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, reason });
  if (!pending) return no('no decision pending');
  if (!isObj(event) || event.service_id !== 'fleet.decide') return no('not a fleet.decide response');
  if (event.provider_peer_id !== pending.provider) return no('response not from the base');
  if (event.encrypted !== true) return no('response was not sealed');
  const r = json(event.body);
  if (!isObj(r) || r.v !== 1) return no('malformed response');
  if (event.status !== 'ok') return no(typeof r.error === 'string' ? r.error.slice(0, 200) : `base answered ${String(event.status)}`);
  if (r.seq !== pending.seq) return no(`wrong seq ${String(r.seq)}, pending ${pending.seq}`);
  if (now > pending.deadline) return no('decision arrived after the deadline');
  if (!isAction(r.action) || !pending.options.includes(r.action)) return no(`action not on offer: ${String(r.action)}`);
  if (r.tee_verified !== true) return no('decision not TEE-verified');
  if (!shortStr(r.request_id, 200)) return no('decision has no 0G request ID');
  return {
    ok: true,
    decision: {
      v: 1,
      seq: r.seq,
      action: r.action,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : '',
      model: typeof r.model === 'string' ? r.model.slice(0, 100) : '',
      request_id: r.request_id,
      tee_verified: true,
      verifiability: typeof r.verifiability === 'string' ? r.verifiability.slice(0, 200) : '',
    },
  };
}

/** A request body as the base receives it (untrusted) → a DecideRequest, or null. */
export function parseDecideRequest(body: unknown): DecideRequest | null {
  if (typeof body !== 'string' || body.length > MAX_BODY) return null;
  const o = json(body);
  if (!isObj(o) || o.v !== 1 || !Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return null;
  if (!shortStr(o.robot) || !shortStr(o.episode) || !shortStr(o.checkpoint)) return null;
  const opts = o.options;
  if (!Array.isArray(opts) || !opts.length || !opts.every(isAction) || new Set(opts).size !== opts.length) return null;
  const p = o.pose;
  if (!isObj(p) || ![p.x, p.y, p.heading, o.battery].every(Number.isFinite)) return null;
  if (typeof o.frame_jpeg_b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.frame_jpeg_b64)) return null;
  return o as DecideRequest;
}
