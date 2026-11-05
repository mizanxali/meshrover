// The sim: rover-a and rover-b in one warehouse, each on its own engine. A
// rover reaches the base only over the mesh: rover-b's engine peers only with
// rover-a's, so everything rover-b sends relays through rover-a. They share
// nothing but the warehouse floor, where each sees the other as an obstacle.
// The dashboard watches the sim's world on a local server-sent-events feed
// (http://127.0.0.1:7300/events, a list of rovers). Each rover's fleet roster
// (who may approve) comes from the base on `fleet.roster` and is cached in
// .run/<rover>/roster.json; no rover ever reads a chain.
// Run: npm run sim   (after src/base/main.ts is up; ROVERS=rover-a for one rover)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type ServerResponse, createServer } from 'node:http';
import { connectEngine } from '../engine.ts';
import { type Roster, parseRoster } from '../protocol.ts';
import { cameraFeed, startFfmpeg } from './camera.ts';
import { Rover } from './rover.ts';
import { type View, renderFrame } from './world.ts';

// Each rover's engine (local API port, from spikes/engines.sh) and where it starts.
const FLEET: Record<string, { port: number; start: { from: string; to: string } }> = {
  'rover-a': { port: 7202, start: { from: 'g', to: 'J1' } }, // J1, facing north
  'rover-b': { port: 7203, start: { from: 'c', to: 'J2' } }, // J2, facing north
};
// Rover A's safety camera (avfoundation device name). CAMERA=none: drawn frames only, as rover B has.
const CAMERA = process.env.CAMERA ?? 'FaceTime HD Camera';
// ponytail: provisioning by file on this Mac; the base's address will come from the ENS roster.
const { address: base, episode } = JSON.parse(readFileSync('.run/base/fleet.json', 'utf8')) as { address: string; episode: string };
mkdirSync(`episodes/${episode}`, { recursive: true });

let rovers: Rover[] = [];

async function launch(name: string) {
  const { port, start } = FLEET[name] ?? (() => { throw new Error(`no rover ${name} (have ${Object.keys(FLEET)})`); })();
  const robot = `${name}.meshrover-demo.eth`;
  const file = `episodes/${episode}/${name}.jsonl`;
  const engine = await connectEngine(name, port);
  let render = (v: View) => renderFrame(v);
  if (name === 'rover-a' && CAMERA !== 'none') {
    const file = `.run/${name}/cam.jpg`;
    startFfmpeg(CAMERA, file); // warms up while the session starts
    const cam = cameraFeed(file);
    render = (v) => renderFrame(v, cam());
  }

  // A service body to a peer with no session goes unsealed, and both sides refuse
  // those. One direct message fetches the base's key package and starts the session.
  const hello = await engine.call('send_message', { recipient: base, content: JSON.stringify({ v: 1, hello: robot }), priority: 'Medium' });
  const helloId = typeof hello === 'string' ? hello : hello?.message_id;
  await engine.waitFor((e) => e.type === 'message_delivered' && e.message_id === helloId, 60_000);
  console.log(`${robot} ${engine.address}: session with base ${base}, episode ${episode}`);

  // Until the first roster arrives (and with no cache), no approver is known, so no approval is accepted.
  const cache = `.run/${name}/roster.json`;
  let roster: Roster = (existsSync(cache) && parseRoster(readFileSync(cache, 'utf8'))) || {};
  let rosterSub = '';
  engine.on((e) => {
    if (e.type !== 'service_update_received' || e.sub_id !== rosterSub || e.provider_peer_id !== base) return;
    const r = parseRoster(e.body);
    if (!r) return void console.error(`${name} fleet.roster: malformed roster from the base, keeping the cached one`);
    roster = r;
    writeFileSync(cache, JSON.stringify(roster, null, 2));
    console.log(`${name}: roster from the base, ${Object.keys(roster).length} names`);
  });
  // Subscriptions don't survive either side's restart: subscribe again whenever one ends.
  void (async () => {
    for (;;) {
      try {
        rosterSub = await engine.call('services.subscribe_service', { provider: base, service_id: 'fleet.roster', topic: 'roster', mode: 'Latest', params: '', keys: [] });
        await engine.waitFor((e) => e.type === 'service_subscription_changed' && e.sub_id === rosterSub && e.state === 'ended', 2 ** 31 - 1);
      } catch (err) {
        // The engine outlives the sim, and so does its subscription: drop that one and take a fresh snapshot.
        const stale = /already subscribed to this topic as (\S+)/.exec((err as Error).message)?.[1];
        if (stale) await engine.call('services.unsubscribe_service', { sub_id: stale }).catch(() => {});
        else console.error(`${name} fleet.roster: ${(err as Error).message}`);
      }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  })();

  const rover: Rover = new Rover({
    robot, episode, base, start, roster: () => roster, render,
    others: () => rovers.filter((r) => r !== rover).map((r) => [r.x, r.y] as const),
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
  return rover;
}

// Each rover joins the warehouse once its session with the base is up. One that can't reach the base stays
// out; the others still drive.
const names = (process.env.ROVERS ?? Object.keys(FLEET).join(',')).split(',');
void Promise.allSettled(names.map((n) => launch(n).then(
  (r) => void (rovers.push(r), r.start(Date.now())),
  (err: Error) => { console.error(`${n} not started: ${err.message}`); throw err; },
))).then((all) => all.every((r) => r.status === 'rejected') && process.exit(1));

// The motion loop: 20 Hz, synchronous, never awaits the network.
let last = performance.now();
setInterval(() => {
  const t = performance.now();
  for (const r of rovers) r.tick(Date.now(), (t - last) / 1000);
  last = t;
}, 50);

const shown = new Map<Rover, string>();
setInterval(() => {
  for (const r of rovers) {
    const s = `${r.state} ${r.reason}`;
    if (s !== shown.get(r)) console.log(new Date().toISOString().slice(11, 23), r.snapshot().robot.split('.')[0], s), shown.set(r, s);
  }
}, 50);

const clients = new Set<ServerResponse>();
createServer((req, res) => {
  if (req.url !== '/events') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  clients.add(res);
  req.on('close', () => clients.delete(res));
}).listen(7300, '127.0.0.1');
setInterval(() => {
  const msg = `data: ${JSON.stringify(rovers.map((r) => r.snapshot()))}\n\n`;
  for (const c of clients) c.write(msg);
}, 100);
