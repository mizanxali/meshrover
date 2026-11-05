// SPDX-License-Identifier: AGPL-3.0-only
// Public data only: no secrets, no World `sub` values.
// Live view: the sim's feed on this Mac (map, rover pose and state, the latest
// 0G decision with its request ID and the frame the model saw).
// Replay: the episodes anchored on Galileo, each downloaded from 0G Storage by
// the root in its anchor and stepped through on the same map.
// Approvals: the base's feed on this Mac lists approvals waiting on an operator
// (World's link and code, as a QR code for the operator's phone).
// Roster: the fleet's members as ENSv2 on Sepolia has them, read here from the chain.
import { renderSVG } from 'uqr';
import { EDGES, NODES, PALLETS, ZONES } from '../../src/sim/map.ts';
import { FLEET as FLEET_NAME, SEPOLIA_RPC, readRoster, sepoliaClient } from '../../src/base/roster.ts';
import { APPROVER_ROLES, type Roster, authorize } from '../../src/protocol.ts';

type Entry = {
  kind: string; seq: number; robot?: string; checkpoint?: string; action?: string; reason?: string; request_id?: string;
  pose?: { x: number; y: number; heading: number }; frame_jpeg_b64?: string; model?: string; tee_verified?: boolean;
  verifiability?: string; t_request_ms?: number; t_decision_ms?: number; zone?: string; approver?: string;
};
type Card = { robot: string; zone: string; link: string; user_code: string; deadline: number };
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
const S = 32; // px per metre
const COLORS: Record<string, string> = { DRIVING: '#2e9d4f', AWAITING_DECISION: '#d89a00', SAFE_STOPPED: '#d0342c', AWAITING_APPROVAL: '#6a4cc7' };
const inZone = (n: string) => Object.values(ZONES).some((z) => z.includes(n));

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <h1>Mesh Rover <small id="conn">connecting…</small></h1>
  <div id="player" hidden>
    <button id="prev">◀</button> <button id="play">play</button> <button id="next">▶</button>
    <input id="step" type="range" min="0" value="0"> <span id="at"></span>
    <button id="live">back to live</button>
  </div>
  <div class="row">
    <canvas id="map" width="${28 * S}" height="${16 * S}"></canvas>
    <aside>
      <div id="state" class="state"></div>
      <div id="reason"></div>
      <div id="cards"></div>
      <h2>Latest 0G decision</h2>
      <dl id="decision"><dd>none yet</dd></dl>
      <img id="frame" alt="the frame the model saw" width="320" height="240">
    </aside>
  </div>
  <h2>Rover log</h2>
  <ol id="log"></ol>
  <h2>Fleet roster <small>${FLEET_NAME} on ENSv2 (Sepolia), read from the chain</small></h2>
  <table id="roster"><tr><td>loading…</td></tr></table>
  <h2>Anchored episodes <small>EpisodeAnchor on 0G Galileo · files on 0G Storage</small></h2>
  <table id="anchors"><tr><td>loading…</td></tr></table>`;
const $ = (id: string) => document.getElementById(id)!;
const ctx = ($('map') as HTMLCanvasElement).getContext('2d')!;
function draw(s: Snapshot | null) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'square';
  ctx.lineWidth = 1.2 * S;
  for (const [a, b] of EDGES) {
    const [ax, ay] = NODES[a]!, [bx, by] = NODES[b]!;
    ctx.strokeStyle = inZone(a) || inZone(b) ? '#ddd3f5' : '#d6d6d6';
    ctx.beginPath(); ctx.moveTo(ax * S, ay * S); ctx.lineTo(bx * S, by * S); ctx.stroke();
  }
  ctx.font = 'bold 14px system-ui';
  for (const [z, nodes] of Object.entries(ZONES)) {
    const x = nodes.reduce((t, n) => t + NODES[n]![0], 0) / nodes.length, y = Math.max(...nodes.map((n) => NODES[n]![1]));
    ctx.fillStyle = '#6a4cc7'; ctx.fillText(`restricted zone ${z}`, x * S - 60, y * S + 34);
  }
  for (const [id, [x, y]] of Object.entries(NODES)) {
    if (!id.startsWith('J')) continue;
    ctx.fillStyle = '#ffd400'; ctx.fillRect(x * S - 14, y * S - 34, 28, 18);
    ctx.fillStyle = '#000'; ctx.fillText(id, x * S - 9, y * S - 20);
  }
  for (const [x, y] of PALLETS) {
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
    (e.kind === 'decision' ? `${esc(e.action)} · <code>${esc(e.request_id)}</code>`
      : e.kind === 'approval' ? `zone ${esc(e.zone)} · approved by ${esc(e.approver)}` : esc(e.reason ?? '')) + '</li>').join('');
}

// The approvals waiting on an operator. The link is the operator's to open; it carries no secret.
let cards: Card[] = [];
const showCards = () => {
  $('cards').innerHTML = cards.map((c) => `<div class="card"><h2>${esc(c.robot)} wants to enter zone ${esc(c.zone)}</h2>` +
    `<p>Approve with World ID, ${Math.max(0, Math.round((c.deadline - Date.now()) / 1000))} s left. Code <b>${esc(c.user_code)}</b></p>` +
    `${renderSVG(c.link, { border: 2 })}<p><a href="${esc(c.link)}" target="_blank" rel="noreferrer">${esc(c.link)}</a></p></div>`).join('');
};
const approvals = new EventSource(APPROVALS);
approvals.onmessage = (e) => { cards = JSON.parse(e.data); showCards(); };
setInterval(() => cards.length && showCards(), 1000);

draw(null);
const feed = new EventSource(FEED);
feed.onmessage = (e) => render(JSON.parse(e.data));
feed.onopen = () => { $('conn').textContent = 'live'; };
feed.onerror = () => { $('conn').textContent = `no sim feed at ${FEED}`; };

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

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
anchors().then((list) => {
  $('anchors').innerHTML = '<tr><th>block</th><th>episode ID</th><th>decisions</th><th>safe-stops</th><th>approvals</th><th>denials</th><th>storage root</th><th>anchor tx</th><th></th></tr>' +
    list.map((a, i) => `<tr><td>${a.block}</td><td><code>${short(a.episodeId)}</code></td><td>${a.decisions}</td><td>${a.safeStops}</td>` +
      `<td>${a.approvals}</td><td>${a.denials}</td><td><a href="${INDEXER}/file?root=${a.root}"><code>${short(a.root)}</code></a></td>` +
      `<td><a href="${EXPLORER}/tx/${a.tx}"><code>${short(a.tx)}</code></a></td><td><button data-i="${i}">replay</button></td></tr>`).join('');
  $('anchors').onclick = (e) => {
    const i = (e.target as HTMLElement).dataset.i;
    if (i !== undefined) void replay(list[+i]!);
  };
}, (e: Error) => { $('anchors').innerHTML = `<tr><td>could not read anchors from ${RPC}: ${esc(e.message)}</td></tr>`; });

const KINDS = ['decision', 'safe_stop', 'approval', 'denied', 'rejected_command'];

// ponytail: trusts the indexer to serve the bytes behind the root; check the Merkle root in the browser if that matters.
async function replay(a: Anchor) {
  $('conn').textContent = `downloading ${short(a.root)} from 0G Storage…`;
  const res = await fetch(`${INDEXER}/file?root=${a.root}`);
  if (!res.ok) return void ($('conn').textContent = `0G Storage answered HTTP ${res.status} for ${short(a.root)}`);
  const entries = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry & { episode?: string })
    .filter((e) => KINDS.includes(e.kind));
  if (!entries.length) return void ($('conn').textContent = `${short(a.root)} holds no episode entries`);
  feed.close();
  approvals.close();
  $('cards').innerHTML = '';
  const episode = entries[0]!.episode ?? a.episodeId;
  const step = $('step') as HTMLInputElement;
  step.max = String(entries.length - 1);
  let timer = 0;
  const show = (i: number) => {
    i = Math.max(0, Math.min(entries.length - 1, i));
    step.value = String(i);
    $('at').textContent = `entry ${i + 1} of ${entries.length}`;
    render(snapshotAt(entries, i, episode));
    if (i === entries.length - 1) stop();
  };
  const stop = () => { clearInterval(timer); timer = 0; $('play').textContent = 'play'; };
  $('prev').onclick = () => { stop(); show(+step.value - 1); };
  $('next').onclick = () => { stop(); show(+step.value + 1); };
  step.oninput = () => { stop(); show(+step.value); };
  $('play').onclick = () => {
    if (timer) return stop();
    if (+step.value === entries.length - 1) show(0);
    $('play').textContent = 'pause';
    timer = window.setInterval(() => show(+step.value + 1), 1000);
  };
  $('live').onclick = () => location.reload();
  $('player').hidden = false;
  $('conn').innerHTML = `replay of ${esc(episode)} · anchored in <a href="${EXPLORER}/tx/${a.tx}">${short(a.tx)}</a>, ` +
    `file <a href="${INDEXER}/file?root=${a.root}">${short(a.root)}</a> on 0G Storage`;
  show(0);
}

/** The episode as the live view would have shown it at entry i: last pose, latest decision, recent entries. */
function snapshotAt(entries: Entry[], i: number, episode: string): Snapshot {
  let pose = { x: 0, y: 0, heading: 0 };
  let last: Snapshot['last'] = null;
  for (const e of entries.slice(0, i + 1)) {
    if (e.pose) pose = e.pose;
    if (e.kind === 'decision') last = {
      seq: e.seq, checkpoint: e.checkpoint ?? '', action: e.action ?? '', reason: e.reason ?? '', model: e.model ?? '',
      request_id: e.request_id ?? '', tee_verified: e.tee_verified === true, verifiability: e.verifiability ?? '',
      latency_ms: (e.t_decision_ms ?? 0) - (e.t_request_ms ?? 0), frame: e.frame_jpeg_b64 ?? '',
    };
  }
  const e = entries[i]!;
  const moving = (e.kind === 'decision' && e.action !== 'stop') || e.kind === 'approval';
  const reason = e.kind === 'approval' ? `zone ${e.zone}: approved by ${e.approver}` : moving ? `0G: ${e.action}` : (e.reason ?? e.kind);
  return {
    robot: e.robot ?? '', episode, state: moving ? 'DRIVING' : 'SAFE_STOPPED', reason,
    ...pose, battery: 0, seq: e.seq, pending: null, last, recent: entries.slice(Math.max(0, i - 7), i + 1).reverse(),
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
  $('roster').innerHTML = '<tr><th>name</th><th>role</th><th>expires</th><th>mesh key (invite)</th><th>may approve</th><th>agent-context</th></tr>' +
    Object.entries(members).map(([name, m]) => {
      const may = authorize(members, name, APPROVER_ROLES, now);
      return `<tr><td>${esc(name)}</td><td>${esc(m.role ?? '(unset)')}</td>` +
        `<td${now < m.expiry ? '' : ' style="color:#d0342c"'}>${new Date(m.expiry).toLocaleString()}${now < m.expiry ? '' : ' (expired)'}</td>` +
        `<td><code>${m.address ? short(m.address) : '—'}</code></td><td>${may ? (m.role === 'robot' || m.role === 'base' ? '—' : `no: ${esc(may)}`) : 'yes'}</td>` +
        `<td>${esc(contexts[name] ?? '')}</td></tr>`;
    }).join('');
}
async function loadRoster() {
  members = await readRoster(ens, inviteAddress, members);
  await Promise.all(Object.entries(members).filter(([, m]) => m.role === 'robot').map(async ([name]) => {
    contexts[name] = await ens.getEnsText({ name, key: 'agent-context' });
  }));
  showRoster();
}
const rosterFailed = (e: Error) => { $('roster').innerHTML = `<tr><td>could not read the roster from ${SEPOLIA_RPC}: ${esc(e.message.split('\n')[0])}</td></tr>`; };
loadRoster().catch(rosterFailed);
setInterval(() => loadRoster().catch(() => showRoster()), 60_000); // keep the last read if a refresh fails
