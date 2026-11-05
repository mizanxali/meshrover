// A local stand-in for the 0G Router, for building while 0G is down.
// Development only: it is not 0G, it attests nothing, and the base uses it only
// when started with ZG_ROUTER_URL pointing here (never as a fallback). The base
// then suffixes the episode with `-mock`, and every request ID starts `mock-`.
// It picks a random offered action other than stop, after 1 to 2.5 s.
// Stop it to see the rover safe-stop with "0G unreachable".
// Run: npx tsx spikes/mock-router.ts, then ZG_ROUTER_URL=http://127.0.0.1:7400/v1 npm run base
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const json = (res: import('node:http').ServerResponse, status: number, body: object, headers = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, { data: [{ id: 'mock', architecture: { input_modalities: ['text', 'image'] }, tee_attested: false, verifiability: 'MOCK' }] });
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: 'not found' });
  let raw = '';
  for await (const c of req) raw += c;
  let options: string[] = [];
  try {
    options = JSON.parse(JSON.parse(raw).messages[1].content[0].text).options;
  } catch {
    return json(res, 400, { error: 'unexpected request shape' });
  }
  const moves = options.filter((o) => o !== 'stop');
  const action = moves[Math.floor(Math.random() * moves.length)] ?? 'stop';
  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1500));
  const id = randomUUID();
  console.log(`${new Date().toISOString().slice(11, 23)} options ${options.join(',')} -> ${action}`);
  json(res, 200, {
    id: `chatcmpl-${id}`,
    model: 'mock',
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ action, reason: 'MOCK: a random offered action' }) } }],
    x_0g_trace: { request_id: `mock-${id}`, provider: 'mock', tee_verified: true }, // mimics the shape only
  }, { 'ZG-Res-Key': id });
}).listen(7400, '127.0.0.1', () => console.log('MOCK 0G Router on http://127.0.0.1:7400/v1 (not 0G, development only)'));
