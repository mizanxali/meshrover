// SPDX-License-Identifier: AGPL-3.0-only
// One simulated rover: the 20 Hz motion loop and the decision state machine.
// `tick` never awaits: a checkpoint fires its request and the loop keeps
// ticking. Only a decision that `acceptDecision` passes sets the rover moving;
// every doubt ends in SAFE_STOPPED, which retries with a new seq.
import { createHash } from 'node:crypto';
import { type Action, type DecideRequest, type DecideResponse, type Pending, ROVER_DEADLINE_MS, acceptDecision } from '../protocol.ts';
import { NODES, STOP_DISTANCE, type View, exits, headingTo, junctionView, nextAlong, palletAhead, palletView } from './world.ts';

export type State = 'DRIVING' | 'AWAITING_DECISION' | 'SAFE_STOPPED';
export type LogEntry = { kind: 'decision' | 'safe_stop'; [k: string]: unknown };

const SPEED = 2; // m/s
export const RETRY_MS = 3000;

type Options = {
  robot: string;
  episode: string;
  base: string; // the base's mesh address: the only provider whose answers count
  send: (req: DecideRequest) => Promise<unknown>;
  log: (e: LogEntry) => void; // synchronous: an entry is on disk before the motion it leads to
  render: (v: View) => string;
};

export class Rover {
  state: State = 'SAFE_STOPPED';
  reason = 'starting';
  x: number;
  y: number;
  heading = 0;
  battery = 1;
  seq = 0;
  pending: Pending | null = null;
  last: (DecideResponse & { checkpoint: string; latency_ms: number; frame: string }) | null = null;
  recent: LogEntry[] = [];
  private from = 'g';
  private to = 'J1';
  private view: View | null = null; // the checkpoint the rover is held at
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
    if (this.state === 'SAFE_STOPPED' && !this.pending && now >= this.retryAt) this.ask(now);
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
    this.go(d.action);
    this.state = 'DRIVING';
    this.reason = `0G: ${d.action}`;
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

  private stop(reason: string, now: number) {
    this.log({ kind: 'safe_stop', seq: this.pending?.seq ?? this.seq, checkpoint: this.view?.checkpoint, reason, t_ms: now });
    this.pending = null;
    this.state = 'SAFE_STOPPED';
    this.reason = reason;
    this.retryAt = now + RETRY_MS;
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
    if (next) return this.follow(this.to, next);
    this.view = junctionView(this.to, this.heading);
    this.state = 'AWAITING_DECISION';
    this.reason = `checkpoint ${this.to}`;
    this.ask(now);
  }

  private go(action: Action) {
    if (action === 'turn_around') return this.follow(this.to, this.from);
    this.follow(this.to, exits(this.to, this.heading)[action]!); // acceptDecision only passes offered actions
  }

  private follow(from: string, to: string) {
    this.from = from;
    this.to = to;
    this.heading = headingTo(from, to);
    this.view = null;
  }

  private log(e: LogEntry) {
    this.o.log({ robot: this.o.robot, episode: this.o.episode, ...e });
    this.recent = [e, ...this.recent].slice(0, 8);
  }
}

const sha256 = (b64: string) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
const round = (n: number) => Math.round(n * 100) / 100;
