// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DecideRequest, ROVER_DEADLINE_MS } from '../protocol.ts';
import { RETRY_MS, Rover, type LogEntry } from './rover.ts';

const BASE = 'off1base';
function rig() {
  const sent: DecideRequest[] = [];
  const log: LogEntry[] = [];
  const rover = new Rover({
    robot: 'rover-a', episode: 'ep-t', base: BASE, render: () => 'AAAA',
    send: async (r) => void sent.push(r), log: (e) => void log.push(e),
  });
  const answer = (seq: number, action: string, now: number) =>
    rover.handle({
      service_id: 'fleet.decide', status: 'ok', provider_peer_id: BASE, encrypted: true,
      body: JSON.stringify({ v: 1, seq, action, reason: 'r', model: 'm', request_id: `req-${seq}`, tee_verified: true }),
    }, now);
  return { rover, sent, log, answer };
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
