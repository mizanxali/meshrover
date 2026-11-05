// SPDX-License-Identifier: AGPL-3.0-only
// S2: ten decisions per model through the 0G Router, in `verified` trust mode.
// Records latency p50/p95, request_id presence, tee_verified, request_id vs
// ZG-Res-Key, valid-JSON rate, and whether response_format json_object works.
// Run: [N_JSON=20] npx tsx spikes/s2-0g.ts [model ...]   (needs ZG_API_KEY in .env)
import { createCanvas } from '@napi-rs/canvas';

process.loadEnvFile();
const KEY = process.env.ZG_API_KEY ?? (() => { throw new Error('ZG_API_KEY missing from .env'); })();
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['qwen3-vl-plus', '0gm-1.0-35b-a3b'];
const N = 10;
const options = ['proceed', 'turn_left', 'turn_right', 'stop'];

// A junction frame: aisle ahead blocked by a pallet, arrow sign pointing left.
const c = createCanvas(320, 240);
const g = c.getContext('2d');
g.fillStyle = '#ddd'; g.fillRect(0, 0, 320, 240);
g.fillStyle = '#555'; g.fillRect(110, 60, 100, 180);
g.fillStyle = '#a0522d'; g.fillRect(120, 120, 80, 60);
g.fillStyle = '#000'; g.font = 'bold 18px sans-serif'; g.fillText('PALLET', 128, 156);
g.fillStyle = '#ff0'; g.fillRect(10, 20, 90, 50);
g.fillStyle = '#000'; g.font = 'bold 36px sans-serif'; g.fillText('← C', 14, 58);
const frame = c.toBuffer('image/jpeg', 60).toString('base64');
console.log('frame bytes (base64):', frame.length);

async function call(model: string, jsonMode: boolean) {
  const t0 = performance.now();
  const res = await fetch('https://router-api.0g.ai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-0G-Provider-Trust-Mode': 'verified' },
    body: JSON.stringify({
      model, verify_tee: true, temperature: 0,
      ...(jsonMode && { response_format: { type: 'json_object' } }),
      messages: [
        { role: 'system', content: `You drive a warehouse rover. Reply with JSON {"action","reason"} only; action must be one of the options.` },
        { role: 'user', content: [
          { type: 'text', text: JSON.stringify({ checkpoint: 'J1', options, pose: { x: 4, y: 2, heading: 90 } }) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame}` } },
        ] },
      ],
    }),
  });
  const ms = performance.now() - t0;
  const body: any = await res.json().catch(() => null);
  const text: string = body?.choices?.[0]?.message?.content ?? '';
  let action: unknown;
  try { action = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')).action; } catch {}
  return {
    status: res.status, ms: Math.round(ms), action, valid: options.includes(action as string),
    request_id: body?.x_0g_trace?.request_id, provider: body?.x_0g_trace?.provider,
    tee_verified: body?.x_0g_trace?.tee_verified, zgResKey: res.headers.get('ZG-Res-Key'), id: body?.id,
    error: res.ok ? undefined : JSON.stringify(body).slice(0, 300),
  };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
for (const model of models) {
  for (const jsonMode of [false, true]) {
    const runs = [];
    for (let i = 0; i < (jsonMode ? Number(process.env.N_JSON ?? 3) : N); i++) {
      const r = await call(model, jsonMode).catch((e) => ({ error: String(e), ms: NaN } as any));
      console.log(model, jsonMode ? '[json_object]' : '', JSON.stringify(r));
      runs.push(r);
    }
    const ok = runs.filter((r) => r.status === 200);
    const ms = ok.map((r) => r.ms);
    console.log(`== ${model}${jsonMode ? ' json_object' : ''}: ${ok.length}/${runs.length} ok, ${runs.filter((r) => r.valid).length} valid actions,`,
      ms.length ? `p50 ${pct(ms, 0.5)} ms, p95 ${pct(ms, 0.95)} ms,` : '',
      `request_id always: ${ok.every((r) => r.request_id)}, tee_verified: ${[...new Set(ok.map((r) => r.tee_verified))]},`,
      `request_id == ZG-Res-Key: ${[...new Set(ok.map((r) => r.request_id === r.zgResKey))]}`);
  }
}
