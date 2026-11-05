// SPDX-License-Identifier: AGPL-3.0-only
// The base: drives its own engine, provides `fleet.decide` over the mesh, asks
// 0G for each decision and writes the episode file (JSONL, frames included).
// Ctrl-C ends the episode: the base refuses further decisions, then records
// the file on 0G Storage and anchors it on Galileo (retrying while offline).
// Run: npm run base   (engines up; ZG_API_KEY, KEYSTORE_PASSWORD in .env; EPISODE optional)
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { type DecideError, type DecideResponse, parseDecideRequest } from '../protocol.ts';
import { type EngineEvent, connectEngine } from '../engine.ts';
import { MOCK, checkModel, decide } from './decide.ts';
import { loadSigner, record } from './record.ts';

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
// ponytail: provisioning by file on this Mac; rovers will take the base's address from the ENS roster instead.
writeFileSync('.run/base/fleet.json', JSON.stringify({ address: engine.address, episode }));
console.log(`base ${engine.address}, episode ${episode}, writing ${file}`);

engine.on((e) => {
  if (e.type === 'service_request_received' && e.service_id === 'fleet.decide') void onDecide(e);
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
