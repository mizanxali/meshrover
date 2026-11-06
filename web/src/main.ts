// Public data only: no secrets, no World `sub` values.
// Live view: the sim's feed on this Mac (map, each rover's pose and state, its
// latest 0G decision with the request ID and the frame the model saw).
// Replay: the episodes anchored on Galileo, each downloaded from 0G Storage by
// the root in its anchor and stepped through on the same map.
// Approvals: the base's feed on this Mac lists the rovers waiting at a zone gate
// (robot, zone, deadline). Approving happens only on the operator's phone.
// Roster: the fleet's members as ENSv2 on Sepolia has them, read here from the chain.
import { EDGES, NODES, PALLETS, ZONES } from '../../src/sim/map.ts';
import { FLEET as FLEET_NAME, SEPOLIA_RPC, readRoster, sepoliaClient } from '../../src/base/roster.ts';
import { APPROVAL_WINDOW_MS, APPROVER_ROLES, BASE_TIMEOUT_MS, type Roster, authorize } from '../../src/protocol.ts';

type Entry = {
  kind: string; seq?: number; robot?: string; checkpoint?: string; action?: string; reason?: string; request_id?: string;
  pose?: { x: number; y: number; heading: number }; frame_jpeg_b64?: string; model?: string; tee_verified?: boolean;
  verifiability?: string; t_request_ms?: number; t_decision_ms?: number; t_ms?: number; zone?: string; approver?: string;
};
type Card = { robot: string; zone: string; deadline: number };
type Snapshot = {
  robot: string; episode: string; state: string; reason: string; x: number; y: number; heading: number;
  battery: number; seq: number; pending: number | null; recent: Entry[];
  last: null | { seq: number; checkpoint: string; action: string; reason: string; model: string; request_id: string; tee_verified: boolean; verifiability: string; latency_ms: number; frame: string };
};

const FEED = 'http://127.0.0.1:7300/events';
const APPROVALS = 'http://127.0.0.1:7301/events';
const RPC = 'https://evmrpc-testnet.0g.ai'; // the Galileo RPC that serves eth_getLogs (100k-block ranges)
const ANCHOR = '0x8530Ec9B37EDc064527c5Dd20BAFE264F78cAF67'; // EpisodeAnchor
const DEPLOY_BLOCK = 64020724;
const FLEET = '0x50074104728d49e1f57ad4abd365fde9246fda5f25d1f2384b17580c47a52b9a'; // namehash('meshrover-demo.eth')
const INDEXER = 'https://indexer-storage-testnet-turbo.0g.ai';
const EXPLORER = 'https://chainscan-galileo.0g.ai';
const S = 32; // map units per metre
const W = 28 * S, H = 16 * S;
const COLORS: Record<string, string> = { DRIVING: '#22c55e', AWAITING_DECISION: '#f5a524', SAFE_STOPPED: '#f04444', AWAITING_APPROVAL: '#a78bfa' };
const STATE_NAMES: Record<string, string> = { DRIVING: 'Driving', AWAITING_DECISION: 'Awaiting 0G', SAFE_STOPPED: 'Safe-stopped', AWAITING_APPROVAL: 'Awaiting human' };
const KIND_COLORS: Record<string, string> = { decision: '#22c55e', safe_stop: '#f04444', approval: '#a78bfa', denied: '#f04444', rejected_command: '#f04444' };
const color = (state: string) => COLORS[state] ?? '#a0a0a0';
const inZone = (n: string) => Object.values(ZONES).some((z) => z.includes(n));
const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const label = (robot: string) => robot.split('.')[0]!.replace(/^rover-/, '').toUpperCase();
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
const words = (action: string) => { const s = action.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const statePill = (state: string) => `<span class="state" style="color:${color(state)}"><i class="dot"></i>${esc(STATE_NAMES[state] ?? state)}</span>`;
/** "in 1 h 20 min" or "3 min ago". */
function rel(t: number, now = Date.now()) {
  const m = Math.round(Math.abs(t - now) / 60_000);
  const s = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`;
  return t > now ? `in ${s}` : `${s} ago`;
}
const bar = (title: string, sub = '', right = '') =>
  `<div class="bar"><span class="title">${title}</span><span class="sub">${sub}</span><span class="right">${right}</span></div>`;

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header>
    <div class="t"><svg class="logo" viewBox="56 64 400 360" aria-hidden="true"><g stroke="#666" stroke-width="28" stroke-linecap="round">
      <line x1="256" y1="168" x2="132" y2="372"/><line x1="256" y1="168" x2="380" y2="372"/><line x1="132" y1="372" x2="380" y2="372"/></g>
      <circle cx="132" cy="372" r="46" fill="#fff"/><circle cx="380" cy="372" r="46" fill="#fff"/>
      <path d="M256 72 L328 226 L256 194 L184 226 Z" fill="#22c55e"/></svg>MeshRover<span>${esc(FLEET_NAME)}</span></div>
    <div class="status">
      <span id="p-sim"><i class="dot"></i>Sim <b>connecting</b></span>
      <span id="p-base"><i class="dot"></i>Base <b>connecting</b></span>
      <span id="p-ens"><i class="dot"></i>ENS roster <b>reading</b></span>
      <span id="p-0g"><i class="dot"></i>0G anchors <b>reading</b></span>
    </div>
    <span id="clock"></span>
  </header>
  <div class="split row">
    <div class="split col">
      <section class="pane" style="flex:1.25 1 0">
        ${bar('Warehouse floor', '<span id="mode">live from the sim</span>', `<span id="player" hidden>
          <button id="prev" aria-label="previous entry">◀</button> <button id="play">Play</button> <button id="next" aria-label="next entry">▶</button>
          <input id="step" type="range" min="0" value="0" aria-label="entry"> <span id="at" class="mono"></span> <button id="live">Back to live</button>
        </span><span id="ep" class="mono na"></span>`)}
        <div class="body" id="mapbody"><canvas id="map"></canvas></div>
      </section>
      <div class="gutter"></div>
      <section class="pane">
        ${bar('Rovers', 'pose, latest 0G decision, the frame the model saw, log')}
        <div class="body" id="rovers"><div class="empty">No rovers on the feed</div></div>
      </section>
    </div>
    <div class="gutter"></div>
    <div class="split col" style="flex:0 0 460px">
      <section class="pane fit" style="flex:0 0 auto">${bar('Fleet', '', '<span id="s-lat" class="na"></span>')}<div class="body" id="fleet"></div></section>
      <div class="gutter"></div>
      <section class="pane">${bar('Approvals', 'World ID, before zone C', '<span id="ncards" style="color:#a78bfa"></span>')}<div class="body" id="cards"></div></section>
      <div class="gutter"></div>
      <section class="pane">${bar('Fleet roster', `${esc(FLEET_NAME)} on ENSv2, Sepolia`)}
        <div class="body"><table id="roster"><tr><td class="msg">Reading the roster from Sepolia…</td></tr></table></div></section>
      <div class="gutter"></div>
      <section class="pane" style="flex:.7 1 0">${bar('Anchored episodes', 'EpisodeAnchor on 0G Galileo, files on 0G Storage')}
        <div class="body"><table id="anchors"><tr><td class="msg">Reading anchors from Galileo…</td></tr></table></div></section>
    </div>
  </div>`;
const $ = (id: string) => document.getElementById(id)!;
/** One header status: `ok`, `warn`, `bad` or none. */
const pill = (id: string, cls: string, text: string, title = '') => {
  const p = $(id);
  p.className = cls;
  p.title = title;
  p.querySelector('b')!.textContent = text;
};
const tick = () => { $('clock').textContent = clock(Date.now()); };
tick();
setInterval(tick, 1000);

// ---- Panes: click a title to collapse, drag a gutter to resize ----

app.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('.title');
  if (t) t.closest('.pane')!.classList.toggle('collapsed');
});
for (const g of document.querySelectorAll<HTMLElement>('.gutter')) {
  g.onpointerdown = (down) => {
    const prev = g.previousElementSibling as HTMLElement, next = g.nextElementSibling as HTMLElement;
    if (prev.classList.contains('collapsed') || next.classList.contains('collapsed')) return;
    const across = g.parentElement!.classList.contains('row');
    const start = across ? prev.offsetWidth : prev.offsetHeight;
    const total = start + (across ? next.offsetWidth : next.offsetHeight);
    const from = across ? down.clientX : down.clientY;
    g.setPointerCapture(down.pointerId);
    g.classList.add('drag');
    g.onpointermove = (m) => {
      const size = Math.max(60, Math.min(total - 60, start + (across ? m.clientX : m.clientY) - from));
      prev.style.flex = `0 0 ${size}px`;
      next.style.flex = '1 1 0';
    };
    g.onpointerup = () => { g.onpointermove = null; g.classList.remove('drag'); };
  };
}

// ---- The map ----

const canvas = $('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const trails = new Map<string, [number, number][]>();
let shown: Snapshot[] = [];
// Fit the map to its pane at the screen's pixel density, then redraw.
new ResizeObserver(([e]) => {
  const { width, height } = e!.contentRect;
  const k = Math.max(0.1, Math.min(width / W, height / H));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${W * k}px`;
  canvas.style.height = `${H * k}px`;
  canvas.width = Math.round(W * k * dpr);
  canvas.height = Math.round(H * k * dpr);
  ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
  draw(shown);
}).observe($('mapbody'));
const box = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
const hex2 = (a: number) => Math.round(a * 255).toString(16).padStart(2, '0');
function draw(list: Snapshot[]) {
  shown = list;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1;
  for (let m = 0; m <= 28; m++) {
    ctx.strokeStyle = m % 4 ? '#ffffff08' : '#ffffff12';
    ctx.beginPath(); ctx.moveTo(m * S, 0); ctx.lineTo(m * S, H); ctx.stroke();
    if (m <= 16) { ctx.beginPath(); ctx.moveTo(0, m * S); ctx.lineTo(W, m * S); ctx.stroke(); }
  }
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#666';
  for (let m = 4; m < 28; m += 4) ctx.fillText(`${m} m`, m * S + 3, 11);
  // Aisles: an edge, a fill, a dashed centre line. Zone aisles get a violet edge.
  const aisle = (w: number, style: (zone: boolean) => string, dash: number[] = []) => {
    ctx.lineWidth = w; ctx.setLineDash(dash); ctx.lineCap = dash.length ? 'butt' : 'square';
    for (const [a, b] of EDGES) {
      const [ax, ay] = NODES[a]!, [bx, by] = NODES[b]!;
      ctx.strokeStyle = style(inZone(a) || inZone(b));
      ctx.beginPath(); ctx.moveTo(ax * S, ay * S); ctx.lineTo(bx * S, by * S); ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  aisle(1.2 * S + 2, (z) => (z ? '#a78bfa99' : '#333'));
  aisle(1.2 * S, () => '#111');
  aisle(1, (z) => (z ? '#a78bfa66' : '#ffffff22'), [6, 8]);
  for (const [z, nodes] of Object.entries(ZONES)) {
    const x = nodes.reduce((t, n) => t + NODES[n]![0], 0) / nodes.length, y = Math.max(...nodes.map((n) => NODES[n]![1]));
    const text = `Restricted zone ${z}: World ID required`;
    ctx.font = '500 12px system-ui'; ctx.fillStyle = '#a78bfa';
    ctx.fillText(text, x * S - ctx.measureText(text).width / 2, y * S + 40);
  }
  for (const [id, [x, y]] of Object.entries(NODES)) {
    if (!id.startsWith('J')) {
      ctx.fillStyle = '#666'; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillText(id, x * S + 24, y * S - 22);
      continue;
    }
    box(x * S - 14, y * S - 38, 28, 18, 2); ctx.fillStyle = '#000'; ctx.fill();
    ctx.strokeStyle = '#f5a524'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#f5a524'; ctx.font = '600 11px ui-monospace, Menlo, monospace'; ctx.fillText(id, x * S - 8, y * S - 25);
  }
  for (const [x, y] of PALLETS) {
    box(x * S - 11, y * S - 11, 22, 22, 2); ctx.fillStyle = '#000'; ctx.fill();
    ctx.strokeStyle = '#f5a524'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x * S - 6, y * S - 6); ctx.lineTo(x * S + 6, y * S + 6); ctx.moveTo(x * S + 6, y * S - 6); ctx.lineTo(x * S - 6, y * S + 6); ctx.stroke();
  }
  for (const s of list) {
    const c = color(s.state);
    const trail = trails.get(s.robot) ?? [];
    const end = trail[trail.length - 1];
    if (!end || Math.hypot(end[0] - s.x, end[1] - s.y) > 0.1) trail.push([s.x, s.y]);
    if (trail.length > 80) trail.shift();
    trails.set(s.robot, trail);
    ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = `${c}${hex2((i / trail.length) * 0.5)}`;
      ctx.beginPath(); ctx.moveTo(trail[i - 1]![0] * S, trail[i - 1]![1] * S); ctx.lineTo(trail[i]![0] * S, trail[i]![1] * S); ctx.stroke();
    }
    ctx.save();
    ctx.translate(s.x * S, s.y * S);
    ctx.fillStyle = '#fff'; ctx.font = '600 12px system-ui'; ctx.fillText(label(s.robot), 14, -12);
    ctx.rotate((s.heading * Math.PI) / 180);
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(9, 9); ctx.lineTo(0, 5); ctx.lineTo(-9, 9); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

// ---- Rover panes, the fleet list and the counts ----

/** Sets innerHTML only when it changes, so a 10 Hz feed doesn't reset scroll or reload images. */
const set = (el: HTMLElement, html: string) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
/** One column per rover, made once and then updated, so its frame doesn't flicker. */
function panel(robot: string) {
  const id = `rover-${label(robot)}`;
  let p = document.getElementById(id);
  if (!p) {
    $('rovers').querySelector('.empty')?.remove();
    p = Object.assign(document.createElement('div'), { id, className: 'rover' });
    p.innerHTML = `<div class="head"><span class="badge">${esc(label(robot))}</span><span class="n">${esc(robot)}</span><span class="ep"></span><span class="pillslot state"></span></div>
      <div class="reason"></div>
      <div class="tele">Position<span class="pos"></span> Heading<span class="hdg"></span> Battery<span class="bat"></span> Seq<span class="seq"></span></div>
      <div class="rbody">
        <div><div class="lbl">Frame the model saw</div><div class="frame"><span class="none">No frame sent yet</span><img alt="the frame the model saw" hidden></div>
          <div class="lbl">Latest 0G decision</div><div class="decision"><span class="na">None yet: the rover holds until 0G answers.</span></div></div>
        <div><div class="lbl">Log</div><ol class="log"></ol></div>
      </div>`;
    $('rovers').append(p);
  }
  return (sel: string) => p!.querySelector<HTMLElement>(sel)!;
}
function render(list: Snapshot[]) {
  draw(list);
  for (const s of list) show(s);
  const n = (state: string) => list.filter((s) => s.state === state).length;
  const lat = list.map((s) => s.last?.latency_ms).filter((v): v is number => v !== undefined);
  set($('s-lat'), lat.length ? `0G ${(lat.reduce((a, b) => a + b, 0) / lat.length / 1000).toFixed(2)} s of ${BASE_TIMEOUT_MS / 1000} s` : '');
  if (list[0]) set($('ep'), esc(list[0].episode));
  set($('fleet'), list.length
    ? `<div class="counts"><span><b>${list.length}</b>rovers</span>${Object.keys(COLORS).map((k) => `<span style="color:${COLORS[k]}"><b>${n(k)}</b>${STATE_NAMES[k]}</span>`).join('')}</div>` +
      list.map((s) => `<div class="fl"><span class="badge">${esc(label(s.robot))}</span><span class="name">${esc(s.robot.split('.')[0])}</span>` +
        `<span class="why">${esc(s.reason)}</span>${statePill(s.state)}</div>`).join('')
    : '<div class="empty">No rovers on the feed</div>');
}
function show(s: Snapshot) {
  const $ = panel(s.robot);
  set($('.pillslot'), statePill(s.state));
  $('.ep').textContent = s.episode;
  $('.reason').textContent = `${s.reason}${s.pending ? ` · waiting on 0G for seq ${s.pending}` : ''}`;
  $('.pos').textContent = `${s.x.toFixed(1)}, ${s.y.toFixed(1)} m`;
  $('.hdg').textContent = `${Math.round(((s.heading % 360) + 360) % 360)}°`;
  $('.bat').textContent = Number.isFinite(s.battery) ? `${Math.round(s.battery * 100)}%` : '—';
  $('.seq').textContent = String(s.seq);
  const d = s.last;
  if (d) {
    const latColor = d.latency_ms < 4000 ? '#22c55e' : d.latency_ms < BASE_TIMEOUT_MS ? '#f5a524' : '#f04444';
    set($('.decision'), `<div class="act" style="color:${d.action === 'stop' ? '#f04444' : '#22c55e'}">${esc(words(d.action))}</div>` +
      `<div class="why">${esc(d.reason)}</div><dl>` +
      `<dt>at</dt><dd>${esc(d.checkpoint)}, seq ${d.seq}</dd>` +
      `<dt>TEE</dt><dd class="clip" title="${esc(d.verifiability)}">${d.tee_verified && !d.verifiability.startsWith('UNVERIFIED') ? '<span class="good">verified</span>' : '<span class="warn-t">not verified</span>'} · ${esc(d.verifiability || 'tier unknown')}</dd>` +
      `<dt>latency</dt><dd>${d.latency_ms} ms<span class="lat"><i style="width:${Math.min(1, d.latency_ms / BASE_TIMEOUT_MS) * 100}%;background:${latColor}"></i></span></dd>` +
      `<dt>model</dt><dd>${esc(d.model)}</dd><dt>request</dt><dd>${esc(d.request_id)}</dd></dl>`);
    const img = $('img') as HTMLImageElement;
    const src = `data:image/jpeg;base64,${d.frame}`;
    if (img.src !== src) img.src = src;
    img.hidden = false;
    $('.none').hidden = true;
  }
  set($('ol'), s.recent.length ? s.recent.map((e) => {
    const t = e.t_ms ?? e.t_decision_ms;
    const what = e.kind === 'decision' ? `<b>${esc(words(e.action ?? ''))}</b>at ${esc(e.checkpoint ?? '')}, seq ${e.seq} · <code>${esc(e.request_id)}</code>`
      : e.kind === 'approval' ? `<b>Approved</b>zone ${esc(e.zone)} by ${esc(e.approver)}`
      : `<b>${esc(words(e.kind))}</b>${esc(e.reason ?? '')}`;
    const c = e.kind === 'decision' && e.action === 'stop' ? '#f5a524' : KIND_COLORS[e.kind] ?? '#a0a0a0';
    return `<li><span class="time">${t ? clock(t) : ''}</span><i class="dot" style="background:${c}"></i><span class="what" title="${esc(what.replace(/<[^>]+>/g, ' '))}">${what}</span></li>`;
  }).join('') : '<li><span></span><span></span><span class="what">Nothing logged yet</span></li>');
}

// The rovers waiting on an operator's approval, which happens in the phone app.
let cards: Card[] = [];
const showCards = () => {
  $('ncards').textContent = cards.length ? `${cards.length} waiting` : '';
  set($('cards'), cards.length ? cards.map((c) => {
    const left = Math.max(0, c.deadline - Date.now());
    return `<div class="card"><div class="t">${esc(c.robot.split('.')[0])} wants to enter <span>zone ${esc(c.zone)}</span></div>` +
      `<div class="meter"><i style="width:${(left / APPROVAL_WINDOW_MS) * 100}%"></i></div>` +
      `<div class="meta">${Math.round(left / 1000)} s left. Waiting for a supervisor to approve with World ID in the operator app.</div></div>`;
  }).join('') : '<div class="empty">No approvals waiting</div>');
};
showCards();
const approvals = new EventSource(APPROVALS);
approvals.onmessage = (e) => { cards = JSON.parse(e.data); showCards(); };
approvals.onopen = () => pill('p-base', 'ok', 'live');
approvals.onerror = () => pill('p-base', 'bad', 'offline', `no base feed at ${APPROVALS}`);
setInterval(() => cards.length && showCards(), 1000);

render([]);
const feed = new EventSource(FEED);
feed.onmessage = (e) => render(JSON.parse(e.data));
feed.onopen = () => pill('p-sim', 'ok', 'live');
feed.onerror = () => pill('p-sim', 'bad', 'offline', `no sim feed at ${FEED}`);

// ---- Replay from the chain ----

type Anchor = { episodeId: string; root: string; decisions: number; safeStops: number; approvals: number; denials: number; tx: string; block: number };

async function rpc(method: string, params: unknown[]) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

/** Every EpisodeAnchored event for this fleet, newest first. */
async function anchors(): Promise<Anchor[]> {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const hex = (n: number) => `0x${n.toString(16)}`;
  const ranges: number[] = [];
  for (let from = DEPLOY_BLOCK; from <= head; from += 100_000) ranges.push(from);
  const logs = (await Promise.all(ranges.map((from) => rpc('eth_getLogs', [{
    address: ANCHOR, topics: [null, FLEET], fromBlock: hex(from), toBlock: hex(Math.min(from + 99_999, head)),
  }])))).flat() as { topics: string[]; data: string; transactionHash: string; blockNumber: string }[];
  return logs.map((l) => {
    const word = (i: number) => `0x${l.data.slice(2 + 64 * i, 66 + 64 * i)}`; // data: root, then the four uint32 counts
    return { episodeId: l.topics[2]!, root: word(0), decisions: Number(word(1)), safeStops: Number(word(2)), approvals: Number(word(3)),
      denials: Number(word(4)), tx: l.transactionHash, block: parseInt(l.blockNumber, 16) };
  }).reverse();
}

const count = (n: number) => `<td class="${n ? '' : 'n0'}">${n}</td>`;
anchors().then((list) => {
  pill('p-0g', 'ok', `${list.length} episode${list.length === 1 ? '' : 's'}`);
  $('anchors').innerHTML = '<thead><tr><th>Block</th><th>Episode ID</th><th>Decisions</th><th>Safe-stops</th><th>Approvals</th><th>Denials</th><th>Storage root</th><th>Anchor tx</th><th></th></tr></thead><tbody>' +
    (list.length ? list.map((a, i) => `<tr><td class="mono">${a.block}</td><td><code>${short(a.episodeId)}</code></td>${count(a.decisions)}${count(a.safeStops)}` +
      `${count(a.approvals)}${count(a.denials)}<td><a href="${INDEXER}/file?root=${a.root}"><code>${short(a.root)}</code></a></td>` +
      `<td><a href="${EXPLORER}/tx/${a.tx}"><code>${short(a.tx)}</code></a></td><td><button data-i="${i}">Replay</button></td></tr>`).join('')
      : '<tr><td class="msg" colspan="9">No episodes anchored yet</td></tr>') + '</tbody>';
  $('anchors').onclick = (e) => {
    const i = (e.target as HTMLElement).dataset.i;
    if (i !== undefined) void replay(list[+i]!);
  };
}, (e: Error) => {
  pill('p-0g', 'bad', 'unreachable', e.message);
  $('anchors').innerHTML = `<tr><td class="msg">Could not read anchors from ${RPC}: ${esc(e.message)}</td></tr>`;
});

const KINDS = ['decision', 'safe_stop', 'approval', 'denied', 'rejected_command'];

// ponytail: trusts the indexer to serve the bytes behind the root; check the Merkle root in the browser if that matters.
async function replay(a: Anchor) {
  pill('p-sim', 'warn', `downloading ${short(a.root)}`);
  const res = await fetch(`${INDEXER}/file?root=${a.root}`);
  if (!res.ok) return void pill('p-sim', 'bad', `0G Storage answered HTTP ${res.status}`);
  const entries = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry & { episode?: string })
    .filter((e) => KINDS.includes(e.kind));
  if (!entries.length) return void pill('p-sim', 'bad', `${short(a.root)} holds no episode entries`);
  feed.close();
  approvals.close();
  cards = [];
  showCards();
  pill('p-sim', 'warn', 'paused for replay');
  pill('p-base', '', 'paused for replay');
  $('rovers').innerHTML = '';
  trails.clear();
  const episode = entries[0]!.episode ?? a.episodeId;
  const step = $('step') as HTMLInputElement;
  step.max = String(entries.length - 1);
  let timer = 0;
  const show = (i: number) => {
    i = Math.max(0, Math.min(entries.length - 1, i));
    step.value = String(i);
    $('at').textContent = `${i + 1} / ${entries.length}`;
    render(snapshotAt(entries, i, episode));
    if (i === entries.length - 1) stop();
  };
  const stop = () => { clearInterval(timer); timer = 0; $('play').textContent = 'Play'; };
  $('prev').onclick = () => { stop(); show(+step.value - 1); };
  $('next').onclick = () => { stop(); show(+step.value + 1); };
  step.oninput = () => { stop(); show(+step.value); };
  $('play').onclick = () => {
    if (timer) return stop();
    if (+step.value === entries.length - 1) show(0);
    $('play').textContent = 'Pause';
    timer = window.setInterval(() => show(+step.value + 1), 1000);
  };
  $('live').onclick = () => location.reload();
  $('player').hidden = false;
  $('ep').hidden = true; // the replay line names the episode
  $('mode').innerHTML = `replay of ${esc(episode)}, anchored in <a href="${EXPLORER}/tx/${a.tx}">${short(a.tx)}</a>, ` +
    `file <a href="${INDEXER}/file?root=${a.root}">${short(a.root)}</a> on 0G Storage`;
  show(0);
}

/** Every rover heard of by entry i, as the live view would have shown it then. */
function snapshotAt(entries: Entry[], i: number, episode: string): Snapshot[] {
  const seen = entries.slice(0, i + 1);
  const robots = [...new Set(seen.map((e) => e.robot))].filter((r) => r !== undefined); // a rejected command names no robot
  return robots.map((robot) => robotAt(seen.filter((e) => e.robot === robot), episode));
}

/** One rover at its last entry: last pose, latest decision, recent entries. */
function robotAt(entries: Entry[], episode: string): Snapshot {
  const i = entries.length - 1;
  let pose = { x: 0, y: 0, heading: 0 };
  let last: Snapshot['last'] = null;
  for (const e of entries) {
    if (e.pose) pose = e.pose;
    if (e.kind === 'decision') last = {
      seq: e.seq ?? 0, checkpoint: e.checkpoint ?? '', action: e.action ?? '', reason: e.reason ?? '', model: e.model ?? '',
      request_id: e.request_id ?? '', tee_verified: e.tee_verified === true, verifiability: e.verifiability ?? '',
      latency_ms: (e.t_decision_ms ?? 0) - (e.t_request_ms ?? 0), frame: e.frame_jpeg_b64 ?? '',
    };
  }
  const e = entries[i]!;
  const moving = (e.kind === 'decision' && e.action !== 'stop') || e.kind === 'approval';
  const reason = e.kind === 'approval' ? `zone ${e.zone}: approved by ${e.approver}` : moving ? `0G: ${e.action}` : (e.reason ?? e.kind);
  return {
    robot: e.robot ?? '', episode, state: moving ? 'DRIVING' : 'SAFE_STOPPED', reason,
    ...pose, battery: NaN, seq: e.seq ?? 0, pending: null, last, recent: entries.slice(Math.max(0, i - 7), i + 1).reverse(),
  };
}

// ---- The roster from ENS ----

/** The address an invite carries, for display: version, flags, a 32-byte key, then the address with its length. */
function inviteAddress(blob: string): Promise<string> {
  const b = Uint8Array.from(atob(blob.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const address = new TextDecoder().decode(b.slice(35, 35 + (b[34] ?? 0)));
  return b[0] === 1 && address.startsWith('off1') ? Promise.resolve(address) : Promise.reject(new Error('not an invite'));
}

const ens = sepoliaClient();
let members: Roster = {};
const contexts: Record<string, string | null> = {};
function showRoster() {
  const now = Date.now();
  const entries = Object.entries(members);
  $('roster').innerHTML = '<thead><tr><th>Name</th><th>Role</th><th>Expires</th><th>Mesh key</th><th>Approves</th><th>agent-context</th></tr></thead><tbody>' +
    (entries.length ? entries.map(([name, m]) => {
      const may = authorize(members, name, APPROVER_ROLES, now);
      const live = now < m.expiry;
      return `<tr><td title="${esc(name)}">${esc(name.split('.')[0])}</td><td class="${esc(m.role ?? 'na')}">${esc(m.role ?? 'unset')}</td>` +
        `<td class="${live ? '' : 'expired'}" title="${esc(new Date(m.expiry).toLocaleString())}">${live ? rel(m.expiry, now) : `expired ${rel(m.expiry, now)}`}</td>` +
        `<td><code class="${m.address ? '' : 'na'}" title="${esc(m.address ?? '')}">${m.address ? short(m.address) : '—'}</code></td>` +
        `<td>${!may ? '<span class="yes">yes</span>' : m.role === 'robot' || m.role === 'base' ? '<span class="na">—</span>' : `<span class="no" title="${esc(may)}">no</span>`}</td>` +
        `<td class="na ctx" title="${esc(contexts[name] ?? '')}">${esc(contexts[name] ?? '')}</td></tr>`;
    }).join('') : '<tr><td class="msg" colspan="6">The fleet name lists no members</td></tr>') + '</tbody>';
}
async function loadRoster() {
  members = await readRoster(ens, inviteAddress, members);
  await Promise.all(Object.entries(members).filter(([, m]) => m.role === 'robot').map(async ([name]) => {
    contexts[name] = await ens.getEnsText({ name, key: 'agent-context' });
  }));
  pill('p-ens', 'ok', `${Object.keys(members).length} members`);
  showRoster();
}
const rosterFailed = (e: Error) => {
  pill('p-ens', 'bad', 'unreachable', e.message.split('\n')[0]);
  $('roster').innerHTML = `<tr><td class="msg">Could not read the roster from ${SEPOLIA_RPC}: ${esc(e.message.split('\n')[0])}</td></tr>`;
};
loadRoster().catch(rosterFailed);
setInterval(() => loadRoster().catch(() => { pill('p-ens', 'warn', 'stale', 'the last refresh failed; showing the previous read'); showRoster(); }), 60_000); // keep the last read if a refresh fails
