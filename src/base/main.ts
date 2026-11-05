// SPDX-License-Identifier: AGPL-3.0-only
// The base: drives its own engine, provides `fleet.decide` over the mesh, asks
// 0G for each decision and writes the episode file (JSONL, frames included).
// It also provides `fleet.approve`: a World ID check by an enrolled operator
// before a rover enters a restricted zone. Pending approvals are served to the
// dashboard on http://127.0.0.1:7301/events (the link and code only, no secret).
// Ctrl-C ends the episode: the base refuses further decisions, then records
// the file on 0G Storage and anchors it on Galileo (retrying while offline).
// Run: npm run base   (engines up; ZG_API_KEY, KEYSTORE_PASSWORD in .env; EPISODE optional)
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type ServerResponse, createServer } from 'node:http';
import {
  APPROVAL_TTL_MS, APPROVER_ROLES, type Approval, type DecideError, type DecideResponse, type Denied, type Roster, authorize,
  parseApproveRequest, parseDecideRequest,
} from '../protocol.ts';
import { type EngineEvent, connectEngine } from '../engine.ts';
import { MOCK, checkModel, decide } from './decide.ts';
import { loadSigner, record } from './record.ts';
import { type Card, operatorOf, verifyHuman } from './world.ts';

process.loadEnvFile();
const KEY = process.env.ZG_API_KEY || (() => { throw new Error('ZG_API_KEY missing from .env'); })();
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
// A mock run's episode is named as one, so it can never be anchored as a 0G record.
const episode = (process.env.EPISODE || `ep-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`) + (MOCK ? '-mock' : '');
if (MOCK) console.warn(`MOCK ROUTER at ${process.env.ZG_ROUTER_URL}: decisions are not from 0G. Development only.`);

mkdirSync(`episodes/${episode}`, { recursive: true });
const file = `episodes/${episode}/base.jsonl`;
const log = (e: object) => appendFileSync(file, JSON.stringify({ episode, ...e }) + '\n');

const wallet = MOCK ? null : await loadSigner(); // a mock episode is never recorded
const { model, verifiability } = await checkModel();
console.log(`0G model ${model} (${verifiability})`);

const engine = await connectEngine('base', 7201);
await engine.call('services.register_service', { service_id: 'fleet.decide', version: '1', capabilities: {} });
await engine.call('services.register_service', { service_id: 'fleet.approve', version: '1', capabilities: {} });
// ponytail: the roster from a file; it will be read from the fleet's ENSv2 names and cached.
const roster: Roster = JSON.parse(readFileSync('config/roster.json', 'utf8'));
// ponytail: provisioning by file on this Mac; rovers will take the base's address from the ENS roster instead.
writeFileSync('.run/base/fleet.json', JSON.stringify({ address: engine.address, episode }));
console.log(`base ${engine.address}, episode ${episode}, writing ${file}`);

engine.on((e) => {
  if (e.type === 'service_request_received' && e.service_id === 'fleet.decide') void onDecide(e);
  if (e.type === 'service_request_received' && e.service_id === 'fleet.approve') void onApprove(e);
});

// Once ended, the file is final: nothing more is logged, so no decision goes out either (it would move a rover unlogged).
let ended = false;
process.once('SIGINT', async () => {
  ended = true;
  console.log(`\nepisode ${episode} ended${wallet ? ', recording it (Ctrl-C again to stop; npm run record -- ' + episode + ' resumes)' : ''}`);
  if (wallet) await record(episode, wallet).catch((e: Error) => console.error(`not recorded: ${e.message}`));
  process.exit(0);
});

async function onDecide(e: EngineEvent) {
  const t_request_ms = Date.now();
  const req = parseDecideRequest(e.body);
  const seq = req?.seq ?? -1;
  const respond = (status: 'ok' | 'error', body: DecideResponse | DecideError) =>
    engine.call('services.respond_to_service_request', {
      request_id: e.request_id, requester: e.sender, service_id: 'fleet.decide', status, body: JSON.stringify(body),
    }).catch((err: Error) => console.error(`respond seq ${seq}: ${err.message}`));
  if (ended) return respond('error', { v: 1, seq, error: 'episode ended' });
  const refuse = (error: string) => {
    log({ kind: 'rejected_command', sender: e.sender, seq, reason: error, t_ms: t_request_ms });
    console.log(`refused ${e.sender} seq ${seq}: ${error}`);
    return respond('error', { v: 1, seq, error });
  };

  // ponytail: any sealed sender may ask; checking the sender against the ENS roster comes with the roster.
  if (e.encrypted !== true) return refuse('request was not sealed');
  if (!req) return refuse('malformed request');
  if (req.episode !== episode) return refuse(`wrong episode ${req.episode}, base is on ${episode}`);

  const d = await decide(req, KEY, verifiability);
  if (ended) return respond('error', { v: 1, seq, error: 'episode ended' });
  const t_decision_ms = Date.now();
  const common = {
    robot: req.robot, seq, checkpoint: req.checkpoint, options: req.options, pose: req.pose,
    frame_sha256: createHash('sha256').update(Buffer.from(req.frame_jpeg_b64, 'base64')).digest('hex'),
    frame_jpeg_b64: req.frame_jpeg_b64, request_id: d.request_id ?? null, t_request_ms, t_decision_ms,
  };
  if ('error' in d) {
    log({ kind: 'safe_stop', ...common, reason: d.error });
    console.log(`${req.robot} seq ${seq} at ${req.checkpoint}: ${d.error} (${t_decision_ms - t_request_ms} ms)`);
    return respond('error', { v: 1, seq, error: d.error });
  }
  log({ kind: 'decision', ...common, action: d.action, reason: d.reason, model: d.model, zg_res_key: d.zg_res_key, provider: d.provider, tee_verified: true, verifiability });
  console.log(`${req.robot} seq ${seq} at ${req.checkpoint}: ${d.action} (${t_decision_ms - t_request_ms} ms, ${d.request_id}) ${d.reason}`);
  return respond('ok', { v: 1, seq, action: d.action, reason: d.reason, model: d.model, request_id: d.request_id, tee_verified: true, verifiability });
}

// Approval cards waiting on an operator, by robot, for the dashboard.
const cards = new Map<string, Card & { robot: string; zone: string }>();
const watchers = new Set<ServerResponse>();
const showCards = () => {
  const msg = `data: ${JSON.stringify([...cards.values()])}\n\n`;
  for (const w of watchers) w.write(msg);
};
createServer((req, res) => {
  if (req.url !== '/events') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  watchers.add(res);
  req.on('close', () => watchers.delete(res));
  showCards();
}).listen(7301, '127.0.0.1');

async function onApprove(e: EngineEvent) {
  const t_request_ms = Date.now();
  const req = parseApproveRequest(e.body);
  const nonce = req?.nonce ?? '';
  const respond = (status: 'ok' | 'error', body: Approval | Denied) =>
    engine.call('services.respond_to_service_request', {
      request_id: e.request_id, requester: e.sender, service_id: 'fleet.approve', status, body: JSON.stringify(body),
    }).catch((err: Error) => console.error(`respond approval ${nonce}: ${err.message}`));
  if (ended) return respond('error', { v: 1, nonce, denied: 'episode ended' });
  const deny = (denied: string, extra: object = {}) => {
    if (ended) return respond('error', { v: 1, nonce, denied: 'episode ended' });
    log({ kind: 'denied', robot: req?.robot, sender: e.sender, seq: req?.seq, zone: req?.zone, nonce, reason: denied, ...extra, t_request_ms, t_ms: Date.now() });
    console.log(`${req?.robot ?? e.sender} zone ${req?.zone}: denied, ${denied}`);
    return respond('error', { v: 1, nonce, denied });
  };

  if (e.encrypted !== true) return deny('request was not sealed');
  if (!req) return deny('malformed request');
  if (req.episode !== episode) return deny(`wrong episode ${req.episode}, base is on ${episode}`);
  const robotWhy = authorize(roster, req.robot, ['robot'], t_request_ms);
  if (robotWhy) return deny(robotWhy);

  console.log(`${req.robot} at zone ${req.zone} gate: waiting for World ID`);
  const human = await verifyHuman((c) => {
    cards.set(req.robot, { ...c, robot: req.robot, zone: req.zone });
    showCards();
    console.log(`  open ${c.link} (code ${c.user_code})`);
  });
  cards.delete(req.robot);
  showCards();
  if ('denied' in human) return deny(human.denied);
  const proof = { acr: human.acr, amr: human.amr, auth_time: human.auth_time }; // never `sub`
  const approver = operatorOf(human);
  if (!approver) return deny('this World ID is not an enrolled operator', proof);
  const now = Date.now();
  const why = authorize(roster, approver, APPROVER_ROLES, now);
  if (why) return deny(why, { approver, ...proof });
  if (ended) return respond('error', { v: 1, nonce, denied: 'episode ended' });

  const approval: Approval = { v: 1, robot: req.robot, action: 'enter_zone', zone: req.zone, approver, nonce, expires_at: now + APPROVAL_TTL_MS };
  log({ kind: 'approval', robot: req.robot, seq: req.seq, zone: req.zone, approver, nonce, expires_at: approval.expires_at, ...proof, t_request_ms, t_ms: now });
  console.log(`${req.robot} zone ${req.zone}: approved by ${approver}`);
  return respond('ok', approval);
}
