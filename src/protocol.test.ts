// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Pending, acceptDecision, parseDecideRequest, parseDecision } from './protocol.ts';

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
