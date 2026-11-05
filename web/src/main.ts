// SPDX-License-Identifier: AGPL-3.0-only
// Public data only: no secrets, no World `sub` values.
// Live view: the sim's feed on this Mac (map, rover pose and state, the latest
// 0G decision with its request ID and the frame the model saw).

type WorldMap = { nodes: Record<string, [number, number]>; edges: [string, string][]; pallets: [number, number][] };
type Entry = { kind: string; seq: number; checkpoint?: string; action?: string; reason?: string; request_id?: string };
type Snapshot = {
  robot: string; episode: string; state: string; reason: string; x: number; y: number; heading: number;
  battery: number; seq: number; pending: number | null; recent: Entry[];
  last: null | { seq: number; checkpoint: string; action: string; reason: string; model: string; request_id: string; tee_verified: boolean; verifiability: string; latency_ms: number; frame: string };
};

const FEED = 'http://127.0.0.1:7300/events';
const S = 32; // px per metre
const COLORS: Record<string, string> = { DRIVING: '#2e9d4f', AWAITING_DECISION: '#d89a00', SAFE_STOPPED: '#d0342c' };

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <h1>Mesh Rover <small id="conn">connecting…</small></h1>
  <div class="row">
    <canvas id="map" width="${28 * S}" height="${16 * S}"></canvas>
    <aside>
      <div id="state" class="state"></div>
      <div id="reason"></div>
      <h2>Latest 0G decision</h2>
      <dl id="decision"><dd>none yet</dd></dl>
      <img id="frame" alt="the frame the model saw" width="320" height="240">
    </aside>
  </div>
  <h2>Rover log</h2>
  <ol id="log"></ol>`;
const $ = (id: string) => document.getElementById(id)!;
const ctx = ($('map') as HTMLCanvasElement).getContext('2d')!;
let map: WorldMap | null = null;

function draw(s: Snapshot | null) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!map) return;
  ctx.lineCap = 'square';
  ctx.strokeStyle = '#d6d6d6';
  ctx.lineWidth = 1.2 * S;
  for (const [a, b] of map.edges) {
    const [ax, ay] = map.nodes[a]!, [bx, by] = map.nodes[b]!;
    ctx.beginPath(); ctx.moveTo(ax * S, ay * S); ctx.lineTo(bx * S, by * S); ctx.stroke();
  }
  ctx.font = 'bold 14px system-ui';
  for (const [id, [x, y]] of Object.entries(map.nodes)) {
    if (!id.startsWith('J')) continue;
    ctx.fillStyle = '#ffd400'; ctx.fillRect(x * S - 14, y * S - 34, 28, 18);
    ctx.fillStyle = '#000'; ctx.fillText(id, x * S - 9, y * S - 20);
  }
  for (const [x, y] of map.pallets) {
    ctx.fillStyle = '#8b4513'; ctx.fillRect(x * S - 12, y * S - 12, 24, 24);
  }
  if (!s) return;
  const h = (s.heading * Math.PI) / 180;
  ctx.save();
  ctx.translate(s.x * S, s.y * S);
  ctx.rotate(h);
  ctx.fillStyle = COLORS[s.state] ?? '#888';
  ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(10, 10); ctx.lineTo(-10, 10); ctx.closePath(); ctx.fill();
  ctx.restore();
}

const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
function render(s: Snapshot) {
  draw(s);
  $('state').textContent = s.state.replace('_', ' ');
  $('state').style.background = COLORS[s.state] ?? '#888';
  $('reason').textContent = `${s.reason}${s.pending ? ` · waiting on seq ${s.pending}` : ''} · ${s.robot} · ${s.episode}`;
  const d = s.last;
  if (d) {
    $('decision').innerHTML = [
      ['checkpoint', `${d.checkpoint} (seq ${d.seq})`], ['action', d.action], ['reason', d.reason],
      ['request ID', d.request_id], ['tee_verified', d.tee_verified], ['TEE tier', d.verifiability || 'unknown'], ['model', d.model], ['latency', `${d.latency_ms} ms`],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    const src = `data:image/jpeg;base64,${d.frame}`;
    if (($('frame') as HTMLImageElement).src !== src) ($('frame') as HTMLImageElement).src = src;
  }
  $('log').innerHTML = s.recent.map((e) =>
    `<li class="${e.kind}"><b>${esc(e.kind)}</b> seq ${e.seq} ${esc(e.checkpoint ?? '')} ` +
    (e.kind === 'decision' ? `${esc(e.action)} · <code>${esc(e.request_id)}</code>` : esc(e.reason ?? '')) + '</li>').join('');
}

const feed = new EventSource(FEED);
feed.addEventListener('map', (e) => { map = JSON.parse(e.data); draw(null); });
feed.onmessage = (e) => render(JSON.parse(e.data));
feed.onopen = () => { $('conn').textContent = 'live'; };
feed.onerror = () => { $('conn').textContent = `no sim feed at ${FEED}`; };
