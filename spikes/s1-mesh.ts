// SPDX-License-Identifier: AGPL-3.0-only
// S1: drive three engines (spikes/engines.sh) through the local API.
// Rover B (peers only with A) calls fleet.decide on the base; we check the
// request reaches the base, the sender is B's address, the response comes back,
// and whether rover-a reports relaying it. Run: npx tsx spikes/s1-mesh.ts
import { readFileSync } from 'node:fs';

type Ev = Record<string, any> & { type: string };

async function connect(name: string, port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const listeners: ((e: Ev) => void)[] = [];
  ws.onmessage = (f) => {
    const m = JSON.parse(String(f.data));
    if ('id' in m) return pending.get(m.id)?.(m);
    const e = m.params as Ev;
    console.log(`[${name}] event ${e.type}`, JSON.stringify(e).slice(0, 200));
    listeners.forEach((l) => l(e));
  };
  const call = (method: string, params: object = {}) =>
    new Promise<any>((ok, fail) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? fail(new Error(`${method}: ${JSON.stringify(m.error)}`)) : ok(m.result)));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
    });
  const next = (match: (e: Ev) => boolean, ms: number) =>
    new Promise<Ev>((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`${name}: timed out after ${ms} ms`)), ms);
      listeners.push((e) => { if (match(e)) { clearTimeout(t); ok(e); } });
    });
  const token = readFileSync(`.run/${name}/token`, 'ascii').trim();
  const hello = await call('hello', { app_id: 'meshrover', client: 's1', token });
  return { name, call, next, address: hello.local_address as string, hello, close: () => ws.close() };
}

const base = await connect('base', 7201);
const roverA = await connect('rover-a', 7202);
const roverB = await connect('rover-b', 7203);
for (const c of [base, roverA, roverB]) console.log(c.name, c.address, c.hello.server);

await base.call('services.register_service', { service_id: 'fleet.decide', version: '1', capabilities: {} });

const relayed = roverA.next((e) => e.type === 'message_relayed', 120_000).then(() => true, () => false);
const frame = 'x'.repeat(20_000); // stands in for a ~20 KB base64 JPEG
const t0 = Date.now();
const gotRequest = base.next((e) => e.type === 'service_request_received' && e.service_id === 'fleet.decide', 120_000);
const reqId = await roverB.call('services.send_service_request', {
  provider: base.address, service_id: 'fleet.decide', method: 'decide',
  body: JSON.stringify({ v: 1, seq: 1, frame_jpeg_b64: frame }),
});
console.log('rover-b request id', reqId);

const req = await gotRequest;
console.log('base got request after', Date.now() - t0, 'ms; sender', req.sender, 'is rover-b:', req.sender === roverB.address,
  'encrypted:', req.encrypted, 'body bytes:', String(req.body).length);

const gotResponse = roverB.next((e) => e.type === 'service_response_received' && e.request_id === reqId, 60_000);
await base.call('services.respond_to_service_request', {
  request_id: req.request_id, requester: req.sender, service_id: 'fleet.decide', status: 'ok',
  body: JSON.stringify({ v: 1, seq: 1, action: 'proceed' }),
});
const res = await gotResponse;
console.log('rover-b got response after', Date.now() - t0, 'ms:', res.status, res.body, 'from base:', res.provider_peer_id === base.address,
  'encrypted:', res.encrypted);
console.log('rover-a reported message_relayed:', await Promise.race([relayed, new Promise((r) => setTimeout(() => r('not within 2s of response'), 2000))]));
for (const c of [base, roverA, roverB]) c.close();
