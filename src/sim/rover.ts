// SPDX-License-Identifier: AGPL-3.0-only
// One simulated rover: the 20 Hz motion loop and the decision state machine.
// `tick` never awaits: a checkpoint fires its request and the loop keeps
// ticking. Only a decision that `acceptDecision` passes sets the rover moving,
// and only an approval that `acceptApproval` passes takes it into a restricted
// zone; every doubt ends in SAFE_STOPPED, which retries with a new seq.
import { createHash, randomBytes } from 'node:crypto';
import {
  type Action, type ApproveRequest, type DecideRequest, type DecideResponse, type Pending, type PendingApproval, type Roster,
  ROVER_APPROVAL_DEADLINE_MS, ROVER_DEADLINE_MS, acceptApproval, acceptDecision,
} from '../protocol.ts';
import { NODES, STOP_DISTANCE, type View, ZONES, exits, headingTo, junctionView, nextAlong, palletAhead, palletView } from './world.ts';

export type State = 'DRIVING' | 'AWAITING_DECISION' | 'AWAITING_APPROVAL' | 'SAFE_STOPPED';
export type LogEntry = { kind: 'decision' | 'safe_stop' | 'approval' | 'denied'; [k: string]: unknown };

const SPEED = 2; // m/s
export const RETRY_MS = 3000;
export const APPROVAL_RETRY_MS = 10_000; // each retry starts a new World ID request, so not too often

type Options = {
  robot: string;
  episode: string;
  base: string; // the base's mesh address: the only provider whose answers count
  roster: Roster; // who may approve, checked again here whatever the base says
  send: (req: DecideRequest) => Promise<unknown>;
  sendApproval: (req: ApproveRequest) => Promise<unknown>;
  log: (e: LogEntry) => void; // synchronous: an entry is on disk before the motion it leads to
  render: (v: View) => string;
};

const zoneOf = (node: string) => Object.keys(ZONES).find((z) => ZONES[z]!.includes(node));

export class Rover {
  state: State = 'SAFE_STOPPED';
  reason = 'starting';
  x: number;
  y: number;
  heading = 0;
  battery = 1;
  seq = 0;
  pending: Pending | null = null;
  approving: PendingApproval | null = null;
  last: (DecideResponse & { checkpoint: string; latency_ms: number; frame: string }) | null = null;
  recent: LogEntry[] = [];
  private from = 'g';
  private to = 'J1';
  private view: View | null = null; // the checkpoint the rover is held at
  private gate: { zone: string; from: string; to: string } | null = null; // the zone entry the rover is held at
  private frame = '';
  private tRequest = 0;
  private retryAt = 0;

  constructor(private o: Options) {
    [this.x, this.y] = NODES[this.to]!;
  }

  /** Begin held at J1, facing north, asking for the first decision. */
  start(now: number) {
    this.arrive(now);
  }

  tick(now: number, dt: number) {
    if (this.pending && now > this.pending.deadline) this.stop('no decision by the deadline', now);
    if (this.approving && now > this.approving.deadline) this.deny('no approval by the deadline', now);
    if (this.state === 'SAFE_STOPPED' && !this.pending && !this.approving && now >= this.retryAt) {
      if (this.gate) this.askApproval(now); // only at a corner: no decision led here
      else this.ask(now);
    }
    if (this.state === 'DRIVING') this.drive(now, dt);
  }

  /** A `service_response_received` event for `fleet.decide`. */
  handle(event: unknown, now: number) {
    const p = this.pending;
    const v = acceptDecision(p, event, now);
    if (!p) return; // nothing pending, so a stray or late answer has nothing to move
    if (!v.ok) return this.stop(v.reason, now);
    const d = v.decision;
    this.pending = null;
    this.last = { ...d, checkpoint: this.view!.checkpoint, latency_ms: now - this.tRequest, frame: this.frame };
    this.log({
      kind: 'decision', seq: d.seq, checkpoint: this.view!.checkpoint, frame_sha256: sha256(this.frame),
      action: d.action, reason: d.reason, model: d.model, request_id: d.request_id, tee_verified: d.tee_verified, verifiability: d.verifiability,
      t_request_ms: this.tRequest, t_decision_ms: now,
    });
    if (d.action === 'stop') {
      // A decision, not a safe-stop: hold and ask again with a new seq.
      this.state = 'SAFE_STOPPED';
      this.reason = `0G chose stop: ${d.reason}`;
      this.retryAt = now + RETRY_MS;
      return;
    }
    this.reason = `0G: ${d.action}`;
    this.go(d.action, now);
  }

  /** A `service_response_received` event for `fleet.approve`. */
  handleApproval(event: unknown, now: number) {
    const p = this.approving;
    const v = acceptApproval(p, event, this.o.roster, now);
    if (!p) return; // nothing pending: a late or replayed approval opens nothing
    if (!v.ok) return this.deny(v.reason, now);
    const a = v.approval;
    this.approving = null;
    this.log({ kind: 'approval', zone: a.zone, action: a.action, approver: a.approver, nonce: a.nonce, expires_at: a.expires_at, t_ms: now });
    const { from, to } = this.gate!;
    this.gate = null;
    this.enter(from, to);
    this.reason = `zone ${a.zone}: approved by ${a.approver}`;
  }

  snapshot() {
    const { robot, episode } = this.o;
    const { state, reason, x, y, heading, battery, seq, last, recent } = this;
    return { robot, episode, state, reason, x, y, heading, battery, seq, pending: this.pending?.seq ?? null, last, recent };
  }

  private ask(now: number) {
    const view = this.view!;
    const seq = ++this.seq;
    this.frame = this.o.render(view);
    this.tRequest = now;
    this.pending = { seq, options: view.options, deadline: now + ROVER_DEADLINE_MS, provider: this.o.base };
    if (this.state !== 'SAFE_STOPPED') this.state = 'AWAITING_DECISION';
    const req: DecideRequest = {
      v: 1, robot: this.o.robot, episode: this.o.episode, seq, checkpoint: view.checkpoint, options: [...view.options],
      pose: { x: round(this.x), y: round(this.y), heading: this.heading }, battery: round(this.battery), frame_jpeg_b64: this.frame,
    };
    this.o.send(req).catch((e: Error) => {
      if (this.pending?.seq === seq) this.stop(`mesh send failed: ${e.message}`, Date.now());
    });
  }

  /** Held outside a zone: ask the base for a human's approval to enter. */
  private askApproval(now: number) {
    const { zone } = this.gate!;
    const nonce = randomBytes(16).toString('hex');
    this.approving = { robot: this.o.robot, zone, nonce, deadline: now + ROVER_APPROVAL_DEADLINE_MS, provider: this.o.base };
    if (this.state !== 'SAFE_STOPPED') this.state = 'AWAITING_APPROVAL';
    this.o.sendApproval({ v: 1, robot: this.o.robot, episode: this.o.episode, seq: ++this.seq, action: 'enter_zone', zone, nonce })
      .catch((e: Error) => {
        if (this.approving?.nonce === nonce) this.deny(`mesh send failed: ${e.message}`, Date.now());
      });
  }

  private stop(reason: string, now: number) {
    this.log({ kind: 'safe_stop', seq: this.pending?.seq ?? this.seq, checkpoint: this.view?.checkpoint, reason, t_ms: now });
    this.pending = null;
    this.state = 'SAFE_STOPPED';
    this.reason = reason;
    this.retryAt = now + RETRY_MS;
  }

  /**
   * No approval: stay outside the zone. At a checkpoint the 0G decision that
   * led here is spent, so the retry asks 0G again (and, if it picks the zone
   * again, a human again). Never enter later on the old decision.
   */
  private deny(reason: string, now: number) {
    const { zone } = this.gate!;
    this.log({ kind: 'denied', zone, nonce: this.approving?.nonce, reason, t_ms: now });
    this.approving = null;
    if (this.view) this.gate = null;
    this.state = 'SAFE_STOPPED';
    this.reason = `zone ${zone}: ${reason}`;
    this.retryAt = now + APPROVAL_RETRY_MS;
  }

  private drive(now: number, dt: number) {
    const step = SPEED * dt;
    if (palletAhead(this.x, this.y, this.heading, STOP_DISTANCE + step)) { // never step past the stop line
      this.view = palletView(this.from, this.to);
      this.state = 'AWAITING_DECISION';
      this.reason = 'pallet ahead';
      return this.ask(now);
    }
    const [tx, ty] = NODES[this.to]!;
    const dist = Math.hypot(tx - this.x, ty - this.y);
    this.battery = Math.max(0, this.battery - step * 0.0005);
    if (step < dist) {
      this.x += ((tx - this.x) / dist) * step;
      this.y += ((ty - this.y) / dist) * step;
      return;
    }
    [this.x, this.y] = [tx, ty];
    this.arrive(now);
  }

  /** At node `to`: follow a corner, or hold at a junction and ask. */
  private arrive(now: number) {
    const next = nextAlong(this.from, this.to);
    if (next) return this.follow(this.to, next, now);
    this.view = junctionView(this.to, this.heading);
    this.state = 'AWAITING_DECISION';
    this.reason = `checkpoint ${this.to}`;
    this.ask(now);
  }

  private go(action: Action, now: number) {
    if (action === 'turn_around') return this.follow(this.to, this.from, now);
    this.follow(this.to, exits(this.to, this.heading)[action]!, now); // acceptDecision only passes offered actions
  }

  /** Head from node `from` (where the rover is) to `to`; into a restricted zone, only after an approval. */
  private follow(from: string, to: string, now: number) {
    const zone = zoneOf(to);
    if (!zone || zone === zoneOf(from)) return this.enter(from, to);
    this.gate = { zone, from, to }; // held where it is, still at its checkpoint
    this.state = 'AWAITING_APPROVAL';
    this.reason = `zone ${zone} gate`;
    this.askApproval(now);
  }

  private enter(from: string, to: string) {
    this.from = from;
    this.to = to;
    this.heading = headingTo(from, to);
    this.view = null;
    this.state = 'DRIVING';
  }

  private log(e: LogEntry) {
    this.o.log({ robot: this.o.robot, episode: this.o.episode, ...e });
    this.recent = [e, ...this.recent].slice(0, 8);
  }
}

const sha256 = (b64: string) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
const round = (n: number) => Math.round(n * 100) / 100;
