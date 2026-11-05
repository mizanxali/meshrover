// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ApproveRequest, type DecideRequest, ROVER_APPROVAL_DEADLINE_MS, ROVER_DEADLINE_MS, type Roster } from '../protocol.ts';
import { APPROVAL_RETRY_MS, RETRY_MS, Rover, type LogEntry } from './rover.ts';

const BASE = 'off1base';
const ROSTER: Roster = {
  'alice.meshrover-demo.eth': { role: 'supervisor', expiry: Infinity },
  'ravi-contractor.meshrover-demo.eth': { role: 'operator', expiry: 0 },
};
function rig() {
  const sent: DecideRequest[] = [];
  const approvals: ApproveRequest[] = [];
  const log: LogEntry[] = [];
  const rover = new Rover({
    robot: 'rover-a', episode: 'ep-t', base: BASE, roster: ROSTER, render: () => 'AAAA',
    send: async (r) => void sent.push(r), sendApproval: async (r) => void approvals.push(r), log: (e) => void log.push(e),
  });
  const answer = (seq: number, action: string, now: number) =>
    rover.handle({
      service_id: 'fleet.decide', status: 'ok', provider_peer_id: BASE, encrypted: true,
      body: JSON.stringify({ v: 1, seq, action, reason: 'r', model: 'm', request_id: `req-${seq}`, tee_verified: true }),
    }, now);
  const approve = (nonce: string, now: number, extra: object = {}, status = 'ok') =>
    rover.handleApproval({
      service_id: 'fleet.approve', status, provider_peer_id: BASE, encrypted: true,
      body: JSON.stringify({ v: 1, robot: 'rover-a', action: 'enter_zone', zone: 'C', approver: 'alice.meshrover-demo.eth', nonce, expires_at: now + 5000, ...extra }),
    }, now);
  return { rover, sent, approvals, log, answer, approve };
}

/** J1 north to a, round to J2, south to c, round to J3, then turn_right towards e: zone C. Returns the time. */
function toGate(r: ReturnType<typeof rig>) {
  const { rover, sent, answer } = r;
  let t = 0;
  rover.start(t);
  for (const action of ['proceed', 'proceed', 'turn_right']) {
    answer(sent.at(-1)!.seq, action, (t += 100));
    while (rover.state === 'DRIVING') rover.tick((t += 50), 0.05);
  }
  return t;
}

test('the rover holds at J1 until a decision, then drives', () => {
  const { rover, sent, log, answer } = rig();
  rover.start(0);
  assert.equal(rover.state, 'AWAITING_DECISION');
  assert.deepEqual(sent[0]!.options, ['proceed', 'turn_right', 'stop']);
  rover.tick(50, 1); // a tick without a decision must not move it
  assert.deepEqual([rover.x, rover.y], [4, 6]);
  answer(1, 'proceed', 3000);
  assert.equal(rover.state, 'DRIVING');
  assert.equal(log.at(-1)!.kind, 'decision'); // logged before the motion
  rover.tick(3050, 0.5);
  assert.equal(rover.y, 5); // north at 2 m/s
});

test('no decision by the deadline means SAFE_STOPPED, and a late answer moves nothing', () => {
  const { rover, sent, log, answer } = rig();
  rover.start(0);
  rover.tick(ROVER_DEADLINE_MS + 1, 0.05);
  assert.equal(rover.state, 'SAFE_STOPPED');
  assert.equal(log.at(-1)!.kind, 'safe_stop');
  answer(1, 'proceed', ROVER_DEADLINE_MS + 100);
  rover.tick(ROVER_DEADLINE_MS + 150, 1);
  assert.equal(rover.state, 'SAFE_STOPPED');
  assert.deepEqual([rover.x, rover.y], [4, 6]);

  // The retry asks again with a new seq, and only that seq's answer counts.
  rover.tick(ROVER_DEADLINE_MS + 1 + RETRY_MS, 0.05);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.seq, 2);
  answer(2, 'turn_right', ROVER_DEADLINE_MS + 1 + RETRY_MS + 100);
  assert.equal(rover.state, 'DRIVING');
  assert.equal(rover.heading, 90);
});

test('a bad answer to the pending seq stops the rover', () => {
  const { rover, answer } = rig();
  rover.start(0);
  answer(1, 'turn_left', 100); // not offered at J1 facing north
  assert.equal(rover.state, 'SAFE_STOPPED');
  assert.match(rover.reason, /not on offer/);
});

test('0G choosing stop holds the rover and asks again later', () => {
  const { rover, sent, answer } = rig();
  rover.start(0);
  answer(1, 'stop', 100);
  assert.equal(rover.state, 'SAFE_STOPPED');
  rover.tick(100 + RETRY_MS, 0.05);
  assert.equal(sent.at(-1)!.seq, 2);
});

test('a pallet ahead halts the motion loop and asks with turn_around', () => {
  const { rover, sent, answer } = rig();
  rover.start(0);
  answer(1, 'turn_right', 100); // east from J1, towards the pallet at x 6.5
  for (let t = 150; rover.state === 'DRIVING' && t < 5000; t += 50) rover.tick(t, 0.05);
  assert.equal(rover.state, 'AWAITING_DECISION');
  assert.ok(rover.x <= 6.5 - 1.5 + 1e-9);
  assert.deepEqual(sent.at(-1)!.options, ['turn_around', 'stop']);
});

test('entering zone C holds the rover at the gate until an approval, logged before it moves', () => {
  const r = rig();
  const { rover, approvals, log, approve } = r;
  const t = toGate(r);
  assert.equal(rover.state, 'AWAITING_APPROVAL');
  assert.deepEqual([rover.x, rover.y], [20, 6]); // held at J3
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.zone, 'C');
  rover.tick(t + 50, 1);
  assert.deepEqual([rover.x, rover.y], [20, 6]);
  approve(approvals[0]!.nonce, t + 100);
  assert.equal(rover.state, 'DRIVING');
  assert.equal(log.at(-1)!.kind, 'approval');
  assert.equal(log.at(-1)!.approver, 'alice.meshrover-demo.eth');
  rover.tick(t + 150, 0.5);
  assert.deepEqual([rover.x, rover.y], [21, 6]); // east into the zone
});

test('a denial, an expired approver or a timeout keeps the rover at the gate, and an old approval opens nothing', () => {
  const r = rig();
  const { rover, sent, approvals, log, answer, approve } = r;
  let t = toGate(r);
  const first = approvals[0]!.nonce;
  approve(first, (t += 100), { v: 1, nonce: first, denied: 'operator cancelled' }, 'error');
  assert.equal(rover.state, 'SAFE_STOPPED');
  assert.equal(log.at(-1)!.kind, 'denied');
  approve(first, (t += 100)); // a replay of the cancelled request's nonce
  rover.tick((t += 50), 1);
  assert.deepEqual([rover.x, rover.y], [20, 6]);

  // The decision that led to the gate is spent: the retry asks 0G again, then a human again.
  const decisions = sent.length;
  rover.tick((t += APPROVAL_RETRY_MS), 0.05);
  assert.equal(sent.length, decisions + 1);
  assert.equal(approvals.length, 1);
  answer(sent.at(-1)!.seq, 'turn_right', (t += 100));
  assert.equal(rover.state, 'AWAITING_APPROVAL');
  assert.equal(approvals.length, 2);
  const second = approvals[1]!.nonce;
  assert.notEqual(second, first);
  approve(first, (t += 100));
  assert.equal(rover.state, 'SAFE_STOPPED'); // the old nonce stops the request: doubt
  assert.match(rover.reason, /does not answer/);

  rover.tick((t += APPROVAL_RETRY_MS), 0.05);
  answer(sent.at(-1)!.seq, 'turn_right', (t += 100));
  approve(approvals[2]!.nonce, (t += 100), { approver: 'ravi-contractor.meshrover-demo.eth' });
  assert.equal(rover.state, 'SAFE_STOPPED');
  assert.match(rover.reason, /expired/);

  rover.tick((t += APPROVAL_RETRY_MS), 0.05);
  answer(sent.at(-1)!.seq, 'turn_right', (t += 100));
  rover.tick((t += ROVER_APPROVAL_DEADLINE_MS + 1), 0.05);
  assert.equal(log.at(-1)!.kind, 'denied');
  assert.match(String(log.at(-1)!.reason), /deadline/);
  assert.deepEqual([rover.x, rover.y], [20, 6]);
});

test('0G turning away at the gate after a denial drives on without an approval', () => {
  const r = rig();
  const { rover, sent, approvals, answer, approve } = r;
  let t = toGate(r);
  approve(approvals[0]!.nonce, (t += 100), { v: 1, nonce: approvals[0]!.nonce, denied: 'operator cancelled' }, 'error');
  rover.tick((t += APPROVAL_RETRY_MS), 0.05);
  assert.deepEqual(sent.at(-1)!.options, ['turn_left', 'turn_right', 'stop']); // J3, arrived heading north
  answer(sent.at(-1)!.seq, 'turn_left', (t += 100)); // towards J2 (and its pallet)
  assert.equal(rover.state, 'DRIVING');
  assert.equal(rover.heading, 270);
  assert.equal(approvals.length, 1);
});
