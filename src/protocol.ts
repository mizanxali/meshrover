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

// ── Human checkpoint (World ID) and the roster ──────────────────────────────

export const APPROVAL_WINDOW_MS = 120_000; // the operator's time to complete World ID
export const APPROVAL_TTL_MS = 10_000; // an approval must be used this soon after it is issued
// The base answers by the end of its window; the margin covers token validation and the mesh.
export const ROVER_APPROVAL_DEADLINE_MS = APPROVAL_WINDOW_MS + 15_000;

export const ROLES = ['robot', 'operator', 'supervisor', 'base'] as const;
export type Role = (typeof ROLES)[number];
export const APPROVER_ROLES: readonly Role[] = ['operator', 'supervisor'];
/**
 * Fleet name → expiry (Unix ms), role and mesh address, as ENS has them. An
 * expired name's records read as unset on chain, so its role may be unknown;
 * a name with no role is never authorized.
 */
export type Roster = Record<string, { expiry: number; role?: Role; address?: string }>;

/**
 * `name` may act as one of `roles` at `now` (and, given `key`, `key` is its
 * mesh address): null, or the reason it may not. Runs on the base and on the rover.
 */
export function authorize(roster: Roster, name: unknown, roles: readonly Role[], now: number, key?: string): string | null {
  if (typeof name !== 'string' || !Object.hasOwn(roster, name)) return `${String(name)} is not in the fleet roster`;
  const m = roster[name]!;
  if (!(now < m.expiry)) return `${name} expired at ${new Date(m.expiry).toISOString()}`;
  if (!m.role || !roles.includes(m.role)) return `${name} is ${m.role ? `a ${m.role}` : 'without a role record'}, not ${roles.join(' or ')}`;
  if (key !== undefined && m.address !== key) return `${key} is not ${name}'s key`;
  return null;
}

/** A roster as the rover receives it on `fleet.roster` → a Roster, or null. */
export function parseRoster(body: unknown): Roster | null {
  if (typeof body !== 'string' || body.length > MAX_BODY) return null;
  const o = json(body);
  if (!isObj(o)) return null;
  const out: Roster = {};
  for (const [name, m] of Object.entries(o)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) || name.length > 255 || !isObj(m) || !Number.isSafeInteger(m.expiry)) return null;
    if (m.role !== undefined && !ROLES.includes(m.role as Role)) return null;
    if (m.address !== undefined && !(typeof m.address === 'string' && /^off1[0-9a-z]{20,90}$/.test(m.address))) return null;
    out[name] = { expiry: m.expiry as number, ...(m.role ? { role: m.role as Role } : {}), ...(m.address ? { address: m.address as string } : {}) };
  }
  return out;
}

/** Rover → base, service `fleet.approve`, method `approve`. The nonce is the rover's, fresh per request. */
export type ApproveRequest = { v: 1; robot: string; episode: string; seq: number; action: 'enter_zone'; zone: string; nonce: string };

/** Base → rover, status `ok`: single use (it echoes the pending nonce) and short-lived. */
export type Approval = { v: 1; robot: string; action: 'enter_zone'; zone: string; approver: string; nonce: string; expires_at: number };

/** Base → rover, status `error`. */
export type Denied = { v: 1; nonce: string; denied: string };

export type PendingApproval = { robot: string; zone: string; nonce: string; deadline: number; provider: string };

/**
 * A `service_response_received` event → the approval it carries, if it is
 * sealed, from the base, answers the pending nonce for this robot and zone,
 * hasn't expired, and names an approver the roster allows right now.
 */
export function acceptApproval(pending: PendingApproval | null, event: unknown, roster: Roster, now: number):
  { ok: true; approval: Approval } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!pending) return no('no approval pending');
  if (!isObj(event) || event.service_id !== 'fleet.approve') return no('not a fleet.approve response');
  if (event.provider_peer_id !== pending.provider) return no('response not from the base');
  if (event.encrypted !== true) return no('response was not sealed');
  const r = json(event.body);
  if (!isObj(r) || r.v !== 1) return no('malformed response');
  if (r.nonce !== pending.nonce) return no('approval does not answer the pending request');
  if (event.status !== 'ok') return no(typeof r.denied === 'string' ? r.denied.slice(0, 200) : `base answered ${String(event.status)}`);
  if (r.robot !== pending.robot || r.action !== 'enter_zone' || r.zone !== pending.zone) return no('approval is for another robot, action or zone');
  if (now > pending.deadline) return no('approval arrived after the deadline');
  if (!Number.isSafeInteger(r.expires_at) || now > (r.expires_at as number)) return no('approval has expired');
  if ((r.expires_at as number) - now > APPROVAL_TTL_MS) return no('approval lasts too long');
  if (!shortStr(r.approver)) return no('approval names no approver');
  const why = authorize(roster, r.approver, APPROVER_ROLES, now);
  if (why) return no(why);
  return { ok: true, approval: { v: 1, robot: pending.robot, action: 'enter_zone', zone: pending.zone, approver: r.approver, nonce: pending.nonce, expires_at: r.expires_at as number } };
}

/** A request body as the base receives it (untrusted) → an ApproveRequest, or null. */
export function parseApproveRequest(body: unknown): ApproveRequest | null {
  if (typeof body !== 'string' || body.length > 4096) return null;
  const o = json(body);
  if (!isObj(o) || o.v !== 1 || !Number.isSafeInteger(o.seq) || (o.seq as number) < 1 || o.action !== 'enter_zone') return null;
  if (!shortStr(o.robot) || !shortStr(o.episode) || !shortStr(o.zone, 8) || typeof o.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(o.nonce)) return null;
  return { v: 1, robot: o.robot, episode: o.episode, seq: o.seq as number, action: 'enter_zone', zone: o.zone, nonce: o.nonce };
}
