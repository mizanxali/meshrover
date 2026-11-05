// SPDX-License-Identifier: AGPL-3.0-only
// The sim: rover-a in the warehouse, on its own engine. It reaches the base
// only over the mesh. The dashboard watches the sim's world on a local
// server-sent-events feed (http://127.0.0.1:7300/events).
// Run: npm run sim   (after src/base/main.ts is up)
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { type ServerResponse, createServer } from 'node:http';
import { connectEngine } from '../engine.ts';
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

const rover = new Rover({
  robot: ROBOT, episode, base, render: renderFrame,
  send: (req) => engine.call('services.send_service_request', {
    provider: base, service_id: 'fleet.decide', method: 'decide', body: JSON.stringify(req),
  }),
  log: (e) => appendFileSync(file, JSON.stringify(e) + '\n'),
});
engine.on((e) => {
  if (e.type === 'service_response_received' && e.service_id === 'fleet.decide') rover.handle(e, Date.now());
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
