// SPDX-License-Identifier: AGPL-3.0-only
// The sim: rover-a in the warehouse, on its own engine. It reaches the base
// only over the mesh. The dashboard watches the sim's world on a local
// server-sent-events feed (http://127.0.0.1:7300/events). The fleet roster
// (who may approve) comes from the base on `fleet.roster` and is cached in
// .run/rover-a/roster.json; the rover never reads a chain.
// Run: npm run sim   (after src/base/main.ts is up)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type ServerResponse, createServer } from 'node:http';
import { connectEngine } from '../engine.ts';
import { type Roster, parseRoster } from '../protocol.ts';
import { Rover } from './rover.ts';
import { renderFrame } from './world.ts';

const ROBOT = 'rover-a.meshrover-demo.eth';
// ponytail: provisioning by file on this Mac; the base's address will come from the ENS roster.
const { address: base, episode } = JSON.parse(readFileSync('.run/base/fleet.json', 'utf8')) as { address: string; episode: string };
mkdirSync(`episodes/${episode}`, { recursive: true });
const file = `episodes/${episode}/rover-a.jsonl`;

const engine = await connectEngine('rover-a', 7202);

// A service body to a peer with no session goes unsealed, and both sides refuse
// those. One direct message fetches the base's key package and starts the session.
const hello = await engine.call('send_message', { recipient: base, content: JSON.stringify({ v: 1, hello: ROBOT }), priority: 'Medium' });
const helloId = typeof hello === 'string' ? hello : hello?.message_id;
await engine.waitFor((e) => e.type === 'message_delivered' && e.message_id === helloId, 60_000);
console.log(`${ROBOT} ${engine.address}: session with base ${base}, episode ${episode}`);

// Until the first roster arrives (and with no cache), no approver is known, so no approval is accepted.
const ROSTER_CACHE = '.run/rover-a/roster.json';
let roster: Roster = (existsSync(ROSTER_CACHE) && parseRoster(readFileSync(ROSTER_CACHE, 'utf8'))) || {};
let rosterSub = '';
engine.on((e) => {
  if (e.type !== 'service_update_received' || e.sub_id !== rosterSub || e.provider_peer_id !== base) return;
  const r = parseRoster(e.body);
  if (!r) return void console.error('fleet.roster: malformed roster from the base, keeping the cached one');
  roster = r;
  writeFileSync(ROSTER_CACHE, JSON.stringify(roster, null, 2));
  console.log(`roster from the base: ${Object.keys(roster).length} names`);
});
// Subscriptions don't survive either side's restart: subscribe again whenever one ends.
void (async () => {
  for (;;) {
    try {
      rosterSub = await engine.call('services.subscribe_service', { provider: base, service_id: 'fleet.roster', topic: 'roster', mode: 'Latest', params: '', keys: [] });
      await engine.waitFor((e) => e.type === 'service_subscription_changed' && e.sub_id === rosterSub && e.state === 'ended', 2 ** 31 - 1);
    } catch (err) {
      console.error(`fleet.roster: ${(err as Error).message}`);
    }
    await new Promise((ok) => setTimeout(ok, 5000));
  }
})();

const rover = new Rover({
  robot: ROBOT, episode, base, roster: () => roster, render: renderFrame,
  send: (req) => engine.call('services.send_service_request', {
    provider: base, service_id: 'fleet.decide', method: 'decide', body: JSON.stringify(req),
  }),
  sendApproval: (req) => engine.call('services.send_service_request', {
    provider: base, service_id: 'fleet.approve', method: 'approve', body: JSON.stringify(req),
  }),
  log: (e) => appendFileSync(file, JSON.stringify(e) + '\n'),
});
engine.on((e) => {
  if (e.type === 'service_response_received' && e.service_id === 'fleet.decide') rover.handle(e, Date.now());
  if (e.type === 'service_response_received' && e.service_id === 'fleet.approve') rover.handleApproval(e, Date.now());
});

// The motion loop: 20 Hz, synchronous, never awaits the network.
let last = performance.now();
rover.start(Date.now());
setInterval(() => {
  const t = performance.now();
  rover.tick(Date.now(), (t - last) / 1000);
  last = t;
}, 50);

let shown = '';
setInterval(() => {
  const s = `${rover.state} ${rover.reason}`;
  if (s !== shown) console.log(new Date().toISOString().slice(11, 23), (shown = s));
}, 50);

const clients = new Set<ServerResponse>();
createServer((req, res) => {
  if (req.url !== '/events') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  clients.add(res);
  req.on('close', () => clients.delete(res));
}).listen(7300, '127.0.0.1');
setInterval(() => {
  const msg = `data: ${JSON.stringify(rover.snapshot())}\n\n`;
  for (const c of clients) c.write(msg);
}, 100);
