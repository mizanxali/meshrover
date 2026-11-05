// SPDX-License-Identifier: AGPL-3.0-only
// The base: drives its own engine, provides `fleet.decide` over the mesh, asks
// 0G for each decision and writes the episode file (JSONL, frames included).
// It also provides `fleet.approve`: a World ID check by an enrolled operator
// before a rover enters a restricted zone. Pending approvals are served to the
// dashboard on http://127.0.0.1:7301/events (the link and code only, no secret).
// Operators' phones subscribe over the mesh (BLE to this engine) to
// `fleet.status` (each rover's state, as the base last heard it) and
// `fleet.approvals` (the same cards), so they keep working with no internet.
// The fleet roster comes from ENSv2 on Sepolia, is cached in
// .run/base/roster.json, and goes to the rovers on `fleet.roster`; the base
// answers only robots whose mesh key the roster lists.
// Ctrl-C ends the episode: the base refuses further decisions, then records
// the file on 0G Storage and anchors it on Galileo (retrying while offline).
// Run: npm run base   (engines up; ZG_API_KEY, KEYSTORE_PASSWORD in .env; EPISODE optional)
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type ServerResponse, createServer } from 'node:http';
import {
  APPROVAL_TTL_MS, APPROVER_ROLES, type Approval, type DecideError, type DecideResponse, type Denied, type Roster, authorize,
  parseApproveRequest, parseDecideRequest,
} from '../protocol.ts';
import { type EngineEvent, connectEngine } from '../engine.ts';
import { MOCK, checkModel, decide } from './decide.ts';
import { loadSigner, record } from './record.ts';
import { FLEET, readRoster, sepoliaClient } from './roster.ts';
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
for (const service_id of ['fleet.status', 'fleet.approvals', 'fleet.roster']) {
  await engine.call('services.register_service', { service_id, version: '1', capabilities: {} });
  // ponytail: any sealed peer may watch (the roster is public on ENS anyway); restrict status and approvals to
  // operators' keys (Rules, allow_peers) once their phones' invites are in ENS.
  await engine.call('services.set_service_subscription_policy', { service_id, policy: { kind: 'AcceptAll' } });
}
const publish = (service_id: string, topic: string, key: string, body: object) =>
  engine.call('services.publish_service_update', { service_id, topic, key, body: JSON.stringify(body) })
    .catch((err: Error) => console.error(`publish ${service_id}: ${err.message}`));
/** What the base last heard of a robot, for the operators' phones. It's the base's view: between checkpoints it hears nothing. */
const tell = (robot: string, state: string, reason: string, extra: object = {}) =>
  void publish('fleet.status', 'rovers', robot, { robot, episode, state, reason, ...extra, t_ms: Date.now() });

// The roster: the cache first, so the base works offline, then ENS every minute. Requests never wait on a read.
const ROSTER_CACHE = '.run/base/roster.json';
let roster: Roster = existsSync(ROSTER_CACHE) ? JSON.parse(readFileSync(ROSTER_CACHE, 'utf8')) : {};
const ens = sepoliaClient(process.env.SEPOLIA_RPC || undefined);
const parseInvite = async (blob: string) => (await engine.call('parse_invite', { blob })).address as string;
let ensError = '';
async function refreshRoster() {
  try {
    const next = await readRoster(ens, parseInvite, roster);
    ensError = '';
    if (JSON.stringify(next) === JSON.stringify(roster)) return;
    roster = next;
    writeFileSync(ROSTER_CACHE, JSON.stringify(roster, null, 2));
    void publish('fleet.roster', 'roster', 'fleet', roster);
    console.log('roster from ENS:');
    for (const [name, m] of Object.entries(roster)) console.log(`  ${name} ${m.role ?? '(no role)'} until ${new Date(m.expiry).toISOString()} ${m.address ?? '(no key)'}`);
  } catch (err) {
    const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
    if (msg !== ensError) console.error(`roster: ENS unreachable, keeping the cached roster (${msg.split('\n')[0]})`);
    ensError = msg;
  }
}
await refreshRoster();
if (!Object.keys(roster).length) throw new Error(`no roster: ENS unreachable and no ${ROSTER_CACHE}`);
void publish('fleet.roster', 'roster', 'fleet', roster); // a restarted provider holds no topics
setInterval(refreshRoster, 60_000);
const baseWhy = authorize(roster, `base.${FLEET}`, ['base'], Date.now(), engine.address);
if (baseWhy) console.warn(`ENS doesn't list this engine as the base: ${baseWhy} (eval "$(npm run -s invites)", then Fleet.s.sol records())`);
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

  if (e.encrypted !== true) return refuse('request was not sealed');
  if (!req) return refuse('malformed request');
  if (req.episode !== episode) return refuse(`wrong episode ${req.episode}, base is on ${episode}`);
  const robotWhy = authorize(roster, req.robot, ['robot'], t_request_ms, e.sender);
  if (robotWhy) return refuse(robotWhy);

  tell(req.robot, 'AWAITING_DECISION', `checkpoint ${req.checkpoint}`, { checkpoint: req.checkpoint, seq });
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
    tell(req.robot, 'SAFE_STOPPED', d.error, { checkpoint: req.checkpoint, seq });
    console.log(`${req.robot} seq ${seq} at ${req.checkpoint}: ${d.error} (${t_decision_ms - t_request_ms} ms)`);
    return respond('error', { v: 1, seq, error: d.error });
  }
  log({ kind: 'decision', ...common, action: d.action, reason: d.reason, model: d.model, zg_res_key: d.zg_res_key, provider: d.provider, tee_verified: true, verifiability });
  tell(req.robot, d.action === 'stop' ? 'SAFE_STOPPED' : 'DRIVING', `0G: ${d.action}`, { checkpoint: req.checkpoint, seq, request_id: d.request_id });
  console.log(`${req.robot} seq ${seq} at ${req.checkpoint}: ${d.action} (${t_decision_ms - t_request_ms} ms, ${d.request_id}) ${d.reason}`);
  return respond('ok', { v: 1, seq, action: d.action, reason: d.reason, model: d.model, request_id: d.request_id, tee_verified: true, verifiability });
}

// Approval cards waiting on an operator, by robot, for the dashboard.
const cards = new Map<string, Card & { robot: string; zone: string }>();
const watchers = new Set<ServerResponse>();
const showCards = () => {
  const list = [...cards.values()];
  const msg = `data: ${JSON.stringify(list)}\n\n`;
  for (const w of watchers) w.write(msg);
  void publish('fleet.approvals', 'pending', 'cards', list);
};
showCards(); // a restarted provider holds no topics: publish the (empty) state at startup
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
    if (req && !authorize(roster, req.robot, ['robot'], Date.now(), e.sender)) tell(req.robot, 'SAFE_STOPPED', `zone ${req.zone}: ${denied}`, { zone: req.zone });
    console.log(`${req?.robot ?? e.sender} zone ${req?.zone}: denied, ${denied}`);
    return respond('error', { v: 1, nonce, denied });
  };

  if (e.encrypted !== true) return deny('request was not sealed');
  if (!req) return deny('malformed request');
  if (req.episode !== episode) return deny(`wrong episode ${req.episode}, base is on ${episode}`);
  const robotWhy = authorize(roster, req.robot, ['robot'], t_request_ms, e.sender);
  if (robotWhy) return deny(robotWhy);

  console.log(`${req.robot} at zone ${req.zone} gate: waiting for World ID`);
  tell(req.robot, 'AWAITING_APPROVAL', `zone ${req.zone} gate: waiting for World ID`, { zone: req.zone });
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
  tell(req.robot, 'DRIVING', `zone ${req.zone}: approved by ${approver}`, { zone: req.zone });
  return respond('ok', approval);
}
