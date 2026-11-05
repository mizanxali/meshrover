// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPROVAL_TTL_MS, type PendingApproval, type Pending, type Roster, acceptApproval, acceptDecision, authorize, parseApproveRequest, parseRoster,
  parseDecideRequest, parseDecision,
} from './protocol.ts';

const options = ['proceed', 'turn_left', 'stop'] as const;

test('parseDecision accepts bare and fenced JSON with an offered action', () => {
  assert.deepEqual(parseDecision('{"action":"turn_left","reason":"pallet"}', options), { action: 'turn_left', reason: 'pallet' });
  assert.deepEqual(parseDecision('```json\n{"action":"stop"}\n```', options), { action: 'stop', reason: '' });
});

test('parseDecision rejects anything else', () => {
  for (const c of [
    undefined,
    '',
    'turn left',
    '{"action":"turn_left"',
    '["turn_left"]',
    '{"reason":"no action"}',
    '{"action":"turn_right"}', // a real action, but not offered
    '{"action":"fly"}',
    '{"action":"proceed","reason":7}',
  ]) assert.equal(parseDecision(c, options), null, String(c));
});

const BASE = 'off1base';
const pending: Pending = { seq: 7, options, deadline: 10_000, provider: BASE };
const event = (body: object, extra: object = {}) => ({
  type: 'service_response_received',
  service_id: 'fleet.decide',
  status: 'ok',
  provider_peer_id: BASE,
  encrypted: true,
  body: JSON.stringify(body),
  ...extra,
});
const good = { v: 1, seq: 7, action: 'turn_left', reason: 'pallet ahead', model: 'm', request_id: 'r-1', tee_verified: true, verifiability: 'TeeTLS: proxied' };

test('acceptDecision accepts a sealed, verified answer to the pending seq before the deadline', () => {
  const v = acceptDecision(pending, event(good), 10_000);
  assert.ok(v.ok);
  assert.equal(v.decision.action, 'turn_left');
  assert.equal(v.decision.request_id, 'r-1');
  assert.equal(v.decision.verifiability, 'TeeTLS: proxied');
});

test('acceptDecision rejects every doubt', () => {
  const cases: [string, Pending | null, unknown, number][] = [
    ['nothing pending', null, event(good), 0],
    ['not an object', pending, 'x', 0],
    ['another service', pending, event(good, { service_id: 'fleet.other' }), 0],
    ['another provider', pending, event(good, { provider_peer_id: 'off1mallory' }), 0],
    ['unsealed', pending, event(good, { encrypted: false }), 0],
    ['body not JSON', pending, event(good, { body: '{' }), 0],
    ['wrong version', pending, event({ ...good, v: 2 }), 0],
    ['error status', pending, event({ v: 1, seq: 7, error: '0G unreachable' }, { status: 'error' }), 0],
    ['error status with an action', pending, event(good, { status: 'error' }), 0],
    ['old seq', pending, event({ ...good, seq: 6 }), 0],
    ['seq as a string', pending, event({ ...good, seq: '7' }), 0],
    ['after the deadline', pending, event(good), 10_001],
    ['action not offered', pending, event({ ...good, action: 'turn_right' }), 0],
    ['unknown action', pending, event({ ...good, action: 'fly' }), 0],
    ['tee_verified false', pending, event({ ...good, tee_verified: false }), 0],
    ['tee_verified missing', pending, event({ ...good, tee_verified: undefined }), 0],
    ['no request id', pending, event({ ...good, request_id: '' }), 0],
  ];
  for (const [name, p, e, now] of cases) assert.equal(acceptDecision(p, e, now).ok, false, name);
  const v = acceptDecision(pending, event({ v: 1, seq: 7, error: '0G unreachable' }, { status: 'error' }), 0);
  assert.deepEqual(v, { ok: false, reason: '0G unreachable' });
});

test('parseDecideRequest takes a well-formed request and rejects malformed ones', () => {
  const req = {
    v: 1, robot: 'rover-a.meshrover-demo.eth', episode: 'ep-1', seq: 1, checkpoint: 'J1',
    options: ['proceed', 'stop'], pose: { x: 4, y: 6, heading: 0 }, battery: 1, frame_jpeg_b64: 'AAAA',
  };
  assert.ok(parseDecideRequest(JSON.stringify(req)));
  for (const bad of [
    { ...req, v: 2 },
    { ...req, seq: 0 },
    { ...req, options: [] },
    { ...req, options: ['proceed', 'fly'] },
    { ...req, options: ['stop', 'stop'] },
    { ...req, pose: { x: 4, y: 6 } },
    { ...req, robot: '' },
    { ...req, frame_jpeg_b64: 'not base64!' },
    { ...req, frame_jpeg_b64: 'A'.repeat(70_000) },
  ]) assert.equal(parseDecideRequest(JSON.stringify(bad)), null, JSON.stringify(bad).slice(0, 80));
  assert.equal(parseDecideRequest('{'), null);
});

const roster: Roster = {
  'alice.meshrover-demo.eth': { role: 'supervisor', expiry: 50_000 },
  'ravi-contractor.meshrover-demo.eth': { role: 'operator', expiry: 1_000 },
  'rover-a.meshrover-demo.eth': { role: 'robot', expiry: 50_000, address: 'off1rovera' },
  'gone.meshrover-demo.eth': { expiry: 50_000 }, // its role record unreadable
};
const APPROVERS = ['operator', 'supervisor'] as const;

test('authorize allows a listed name with the right role before its expiry, and no one else', () => {
  assert.equal(authorize(roster, 'alice.meshrover-demo.eth', APPROVERS, 10_000), null);
  assert.equal(authorize(roster, 'ravi-contractor.meshrover-demo.eth', APPROVERS, 999), null);
  assert.match(authorize(roster, 'ravi-contractor.meshrover-demo.eth', APPROVERS, 1_000)!, /expired/);
  assert.match(authorize(roster, 'rover-a.meshrover-demo.eth', APPROVERS, 0)!, /is a robot/);
  assert.match(authorize(roster, 'mallory.meshrover-demo.eth', APPROVERS, 0)!, /not in the fleet roster/);
  assert.match(authorize(roster, 'toString', APPROVERS, 0)!, /not in the fleet roster/); // no prototype keys
  assert.match(authorize(roster, undefined, APPROVERS, 0)!, /not in the fleet roster/);
  assert.match(authorize(roster, 'gone.meshrover-demo.eth', APPROVERS, 0)!, /without a role record/);
  assert.match(authorize({ ...roster, 'ravi-contractor.meshrover-demo.eth': { expiry: 1_000 } }, 'ravi-contractor.meshrover-demo.eth', APPROVERS, 1_000)!, /expired/);
});

test('authorize with a key allows only the mesh address ENS lists for that name', () => {
  assert.equal(authorize(roster, 'rover-a.meshrover-demo.eth', ['robot'], 0, 'off1rovera'), null);
  assert.match(authorize(roster, 'rover-a.meshrover-demo.eth', ['robot'], 0, 'off1mallory')!, /not rover-a.meshrover-demo.eth's key/);
  assert.match(authorize(roster, 'alice.meshrover-demo.eth', ['supervisor'], 0, 'off1rovera')!, /not alice/); // no invite record: no key
});

test('parseRoster takes a well-formed roster and refuses anything else', () => {
  const good = { 'rover-a.meshrover-demo.eth': { role: 'robot', expiry: 5, address: 'off1qxzpjpvljhh5qra4zayksypvqx5p6wuahcer6jcx' }, 'gone.meshrover-demo.eth': { expiry: 0 } };
  assert.deepEqual(parseRoster(JSON.stringify(good)), good);
  for (const bad of [
    null, [], 'x',
    { 'Rover.eth': { role: 'robot', expiry: 5 } },
    { 'rover-a.eth': { role: 'admin', expiry: 5 } },
    { 'rover-a.eth': { role: 'robot', expiry: 1.5 } },
    { 'rover-a.eth': { role: 'robot' } },
    { 'rover-a.eth': { role: 'robot', expiry: 5, address: 'mallory' } },
  ]) assert.equal(parseRoster(JSON.stringify(bad)), null, JSON.stringify(bad));
  assert.equal(parseRoster('{"__proto__": {"expiry": 5}}'), null);
  assert.equal(parseRoster('{'), null);
  assert.equal(parseRoster(42), null);
});

const NONCE = 'ab'.repeat(16);
const pendingA: PendingApproval = { robot: 'rover-a.meshrover-demo.eth', zone: 'C', nonce: NONCE, deadline: 20_000, provider: BASE };
const approval = { v: 1, robot: 'rover-a.meshrover-demo.eth', action: 'enter_zone', zone: 'C', approver: 'alice.meshrover-demo.eth', nonce: NONCE, expires_at: 15_000 };
const approveEvent = (body: object, extra: object = {}) => event(body, { service_id: 'fleet.approve', ...extra });

test('acceptApproval accepts a sealed approval for the pending nonce, robot and zone, from an allowed approver', () => {
  const v = acceptApproval(pendingA, approveEvent(approval), roster, 10_000);
  assert.ok(v.ok);
  assert.equal(v.approval.approver, 'alice.meshrover-demo.eth');
});

test('acceptApproval rejects every doubt', () => {
  const cases: [string, PendingApproval | null, unknown, number][] = [
    ['nothing pending', null, approveEvent(approval), 10_000],
    ['a decision response', pendingA, event(approval), 10_000],
    ['another provider', pendingA, approveEvent(approval, { provider_peer_id: 'off1mallory' }), 10_000],
    ['unsealed', pendingA, approveEvent(approval, { encrypted: false }), 10_000],
    ['body not JSON', pendingA, approveEvent(approval, { body: '{' }), 10_000],
    ['wrong version', pendingA, approveEvent({ ...approval, v: 2 }), 10_000],
    ['denied', pendingA, approveEvent({ v: 1, nonce: NONCE, denied: 'operator cancelled' }, { status: 'error' }), 10_000],
    ['error status with an approval body', pendingA, approveEvent(approval, { status: 'error' }), 10_000],
    ['replayed: an old nonce', pendingA, approveEvent({ ...approval, nonce: 'cd'.repeat(16) }), 10_000],
    ['another robot', pendingA, approveEvent({ ...approval, robot: 'rover-b.meshrover-demo.eth' }), 10_000],
    ['another zone', pendingA, approveEvent({ ...approval, zone: 'D' }), 10_000],
    ['another action', pendingA, approveEvent({ ...approval, action: 'override_stop' }), 10_000],
    ['after the deadline', pendingA, approveEvent({ ...approval, expires_at: 25_000 }), 20_001],
    ['expired', pendingA, approveEvent(approval), 15_001],
    ['no expiry', pendingA, approveEvent({ ...approval, expires_at: undefined }), 10_000],
    ['lasts too long', pendingA, approveEvent({ ...approval, expires_at: 10_000 + APPROVAL_TTL_MS + 1 }), 10_000],
    ['no approver', pendingA, approveEvent({ ...approval, approver: '' }), 10_000],
    ['approver not in the roster', pendingA, approveEvent({ ...approval, approver: 'mallory.meshrover-demo.eth' }), 10_000],
    ['approver expired', pendingA, approveEvent({ ...approval, approver: 'ravi-contractor.meshrover-demo.eth' }), 10_000],
    ['approver is a robot', pendingA, approveEvent({ ...approval, approver: 'rover-a.meshrover-demo.eth' }), 10_000],
  ];
  for (const [name, p, e, now] of cases) assert.equal(acceptApproval(p, e, roster, now).ok, false, name);
  const v = acceptApproval(pendingA, approveEvent({ v: 1, nonce: NONCE, denied: 'operator cancelled' }, { status: 'error' }), roster, 0);
  assert.deepEqual(v, { ok: false, reason: 'operator cancelled' });
});

test('parseApproveRequest takes a well-formed request and rejects malformed ones', () => {
  const req = { v: 1, robot: 'rover-a.meshrover-demo.eth', episode: 'ep-1', seq: 3, action: 'enter_zone', zone: 'C', nonce: NONCE };
  assert.deepEqual(parseApproveRequest(JSON.stringify(req)), req);
  for (const bad of [
    { ...req, v: 2 }, { ...req, seq: 0 }, { ...req, action: 'override_stop' }, { ...req, zone: '' },
    { ...req, nonce: 'short' }, { ...req, nonce: 'AB'.repeat(16) }, { ...req, robot: 7 },
  ]) assert.equal(parseApproveRequest(JSON.stringify(bad)), null, JSON.stringify(bad));
  assert.equal(parseApproveRequest('{'), null);
});
