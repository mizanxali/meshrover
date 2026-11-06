# MeshRover

**Robots that never need the internet, and stop safely when their AI is out of reach.**

Rovers talk to their base station entirely offline, over an encrypted
Offline Protocol mesh, with no internet, cloud or cell signal on the robot.
Only the base reaches out: it gets each decision from 0G at a checkpoint. When
the base can't reach 0G, the rovers stop for real. They also ask a verified
human (World ID) before anything risky, and obey only keys that their fleet's
ENSv2 records allow. Built for ETHGlobal Mumbai.

**Live dashboard:** [meshrover.app](https://meshrover.app) shows the fleet roster read from ENS,
the episodes anchored on 0G Chain, and a replay of each from 0G Storage.

## The problem

Field robots (warehouses, farms, construction, inspection, search and rescue)
lose their internet link all the time. When they do:

1. **They keep acting on a stale plan.** An unreachable cloud brain should
   mean "stop". Most stacks instead freeze in an unknown state, or fall back
   to a local guess that nobody audited.
2. **The fallback link is open to anyone nearby.** Local radio control is
   usually unauthenticated, so anyone in range can send "go".

The mesh tells a robot whether it still has a path to its brain, MLS makes the
local link refuse a stranger's command, and ENS says whose commands count.

## The demo

Two rovers drive a warehouse map. At each junction, a rover sends a camera
frame over the mesh to the base station, which asks a 0G vision model what to
do and returns the decision with its request ID. Rover A's frame also carries
a live picture from the laptop's webcam, its safety camera: a hand over the
lens means stop. Turn off the base's Wi-Fi,
and the next rover to reach a junction stops and says why, while the
operator's phone still sees it over Bluetooth. Turn the Wi-Fi back on, and
the rover carries on. When a rover wants to enter the restricted zone, the
operator approves with World ID and it goes in. The next time, they cancel,
and it stays put. A contractor whose ENS subname has expired tries to approve,
and is refused. Finally, the episode's anchor on 0G Chain points to its log on
0G Storage, and the dashboard replays it from there.

## How it works

```
                 internet (the laptop's Wi-Fi; the demo turns it off)
                                    │
 ┌──────────────────────────────────┴───────────────────────────┐
 │ Base station (laptop)                                        │──▶ 0G Router: decisions
 │   offline-protocol-service engine + Node brain bridge:       │──▶ 0G Storage: episode files
 │   fleet.decide · fleet.approve · fleet.status ·              │──▶ 0G Chain: episode anchors
 │   fleet.approvals · fleet.roster · episode log · dashboard   │──▶ World: human checkpoint
 └───────┬────────────────────────────────────────┬─────────────┘──▶ ENSv2 on Sepolia: roster
         │ mesh over loopback                     │ mesh over BLE
         │ (rovers run on the laptop)             │ (phone or base can dial)
 ┌───────┴────────────┐                ┌──────────┴─────────────┐
 │ Rover A (sim)      │                │ Operator phone (RN)    │
 │ + laptop webcam    │                │ status, approvals      │
 └───────┬────────────┘                │                        │
         │ relays for                  └────────────────────────┘
 ┌───────┴────────────┐
 │ Rover B (sim)      │  peers only with Rover A
 └────────────────────┘

 Every mesh message is sealed with MLS. No rover or mesh link uses the internet.
```

"0G is the brain, not the spinal cord." Motion stays on the robot, and 0G
decides at checkpoints and keeps the record.

| Loop | Runs on | Needs the network? | What it does |
|---|---|---|---|
| Motion | the rover, 20 Hz | never | follows the current segment, stops for obstacles |
| Decision | rover → base → 0G, at each checkpoint | mesh and internet | chooses the next segment from the options offered |
| Human checkpoint | rover → base → World → operator | mesh and internet | approves risky actions |
| Record | base → 0G Storage, then 0G Chain | internet, afterwards | keeps every decision, stop, approval and denial, anchored once per episode |

### Rover state machine

```
DRIVING ──checkpoint──▶ AWAITING_DECISION ──a valid decision from 0G──▶ DRIVING
                              │
                              │ deadline passed, wrong seq, or an action not on offer
                              ▼
                        SAFE_STOPPED ──retries with a new seq; a valid decision──▶ DRIVING

DRIVING ──zone gate──▶ AWAITING_APPROVAL ──a valid approval──▶ DRIVING
                              │
                              │ denied, expired, or the approver isn't authorized
                              ▼
                        SAFE_STOPPED (holds; the decision that led here is spent,
                                      so it asks 0G again, then a human again)
```

### Safe-stop rules

1. A decision counts only if it answers the rover's pending `seq` and arrives
   before the rover's deadline.
2. No decision by the deadline means stop and hold. There is no local model,
   no "default proceed" and no last-known plan.
3. An answer that doesn't parse, or names an action that wasn't offered, is
   not a decision.
4. The motion loop never waits on the network. Only checkpoints do.
5. An approval is single-use and expires.
6. A command from a key that isn't in the cached roster with the right role,
   or whose name has expired, is dropped and logged.
7. A log entry that leads to motion is written before the motion starts.
8. Nothing a rover does waits on a blockchain. The chain holds the record
   after the fact; it never carries or gates a command.

### Safety camera

Rover A's checkpoint frame is 640×240: the drawn view of the aisles on the
left, the laptop webcam's latest picture on the right, labelled SAFETY CAM.
The webcam can only make 0G more careful: the simulator still decides which
aisles exist and which options are offered, and the prompt says a hand or an
object close to the lens means `stop`. `ffmpeg` writes two frames a second,
decoded off the motion loop. If the newest one is missing or more than 2 s
old, the rover sends nothing and safe-stops with "camera unavailable", so a
dead camera can never mean "carry on". Every frame goes into the episode
file, which is public once recorded, so the camera should show the desk, not
people.

### Services on the mesh

All on the base's engine, sealed with MLS once a session exists (a rover sends
the base one direct message at startup to start it, and both sides refuse an
unsealed `fleet.*` body).

| Service | Kind | What |
|---|---|---|
| `fleet.decide` | request | a rover's checkpoint frame and options, answered with a 0G decision or an error |
| `fleet.approve` | request | a rover at a zone gate, answered after World ID with a single-use approval or a denial |
| `fleet.status` | subscription, topic `rovers` | each rover's state as the base last heard it, for the operator phones |
| `fleet.approvals` | subscription, topic `pending` | the open approval cards (World's link and code) |
| `fleet.roster` | subscription, topic `roster` | the fleet roster from ENS, which each rover caches |

### Messages

Decision request (rover → base, service `fleet.decide`, method `decide`;
bodies are capped at 64 KiB):

```json
{
  "v": 1,
  "robot": "rover-b.meshrover-demo.eth",
  "episode": "ep-1105-01",
  "seq": 14,
  "checkpoint": "J3",
  "options": ["proceed", "turn_left", "turn_right", "stop"],
  "pose": { "x": 12.5, "y": 4.0, "heading": 90 },
  "battery": 0.71,
  "frame_jpeg_b64": "..."
}
```

The base turns each request into one chat completion on the 0G Router
(temperature 0, `response_format: json_object`, `verify_tee: true`). The user
message is `{checkpoint, options, pose}` as JSON plus the frame as a JPEG data
URL. The system prompt
([`src/base/decide.ts:41`](src/base/decide.ts#L41)):

```text
You drive a warehouse rover. The image is its forward camera at a checkpoint.
It shows up to three regions: LEFT, AHEAD and RIGHT. A dark opening is an aisle; orange shelving means there is no aisle that way; a brown PALLET box blocks that aisle; a blue ROVER is another robot in the way, which may move off (stop waits for it).
proceed = drive AHEAD, turn_left = take the LEFT aisle, turn_right = take the RIGHT aisle, turn_around = go back the way you came, stop = hold here.
Some frames also have a SAFETY CAM panel on the right: a live photo from the rover's real camera. If a hand or an object is close to the lens, covering much of the picture, choose stop, whatever the drawn view shows. A person further back (the operator at the desk) is normal.
Never choose an aisle blocked by a pallet. If you are unsure, choose stop.
Reply with JSON {"action": "...", "reason": "..."} only. action must be one of the options given.
```

Decision response:

```json
{
  "v": 1,
  "seq": 14,
  "action": "turn_left",
  "reason": "pallet blocks the aisle ahead",
  "model": "0gm-1.0-35b-a3b",
  "request_id": "<x_0g_trace.request_id>",
  "tee_verified": true,
  "verifiability": "<the model's TEE tier, in words>"
}
```

Approval request (rover → base, service `fleet.approve`, method `approve`; the
nonce is the rover's, fresh for each request):

```json
{
  "v": 1,
  "robot": "rover-a.meshrover-demo.eth",
  "episode": "ep-1105-01",
  "seq": 22,
  "action": "enter_zone",
  "zone": "C",
  "nonce": "b3f1..."
}
```

Approval (base → rover, status `ok`; it echoes the pending nonce, so it is
single use, and it expires 10 s after it is issued). A denial is status
`error` with `{ "v": 1, "nonce": "b3f1...", "denied": "<why>" }`:

```json
{
  "v": 1,
  "robot": "rover-a.meshrover-demo.eth",
  "action": "enter_zone",
  "zone": "C",
  "approver": "alice.meshrover-demo.eth",
  "nonce": "b3f1...",
  "expires_at": 1762500120000
}
```

Episode log entry (one JSON line in the base's `base.jsonl`, the file that is
recorded). `kind` is one of `decision`, `safe_stop`, `approval`, `denied` or
`rejected_command`. A decision carries the frame the model saw, so the
anchored root covers the frames too:

```json
{
  "episode": "ep-1105-01",
  "kind": "decision",
  "robot": "rover-b.meshrover-demo.eth",
  "seq": 14,
  "checkpoint": "J3",
  "options": ["proceed", "turn_left", "turn_right", "stop"],
  "pose": { "x": 12.5, "y": 4.0, "heading": 90 },
  "frame_sha256": "...",
  "frame_jpeg_b64": "...",
  "request_id": "<x_0g_trace.request_id>",
  "action": "turn_left",
  "reason": "pallet blocks the aisle ahead",
  "model": "0gm-1.0-35b-a3b",
  "zg_res_key": "<ZG-Res-Key header>",
  "provider": "0x...",
  "tee_verified": true,
  "verifiability": "...",
  "t_request_ms": 1762500000000,
  "t_decision_ms": 1762500001240
}
```

Each rover keeps its own log too (`episodes/<ep>/<rover>.jsonl`), written
before the motion an entry leads to.

## Partner integrations

| Partner | What it does here | Where it lives |
|---|---|---|
| **0G Compute** | A vision model picks every move, called through the Router in `verified` trust mode with `verify_tee: true` and temperature 0. A reply without `tee_verified: true` is an error, never a decision. At startup the base checks the model is listed, takes images and is TEE-attested, or refuses to start | [`src/base/decide.ts:30`](src/base/decide.ts#L30) (`checkModel`), [`:59`](src/base/decide.ts#L59) (`decide`), [`:93`](src/base/decide.ts#L93) (TEE check) |
| **0G Storage** | One JSONL file per episode, with every decision's request ID and frame, uploaded when the episode ends (retried every 15 s while offline) | [`src/base/record.ts:61`](src/base/record.ts#L61) (`record`), [`:74`](src/base/record.ts#L74) (upload) |
| **0G Chain** | `EpisodeAnchor` on Galileo: one record per episode (storage root and counts), written by the base only, once per episode. The dashboard lists the anchors and replays an episode from its root | [`contracts/src/EpisodeAnchor.sol:23`](contracts/src/EpisodeAnchor.sol#L23), [`src/base/record.ts:88`](src/base/record.ts#L88), [`web/src/main.ts:323`](web/src/main.ts#L323) |
| **World ID Agent Pass** | A human checkpoint before a rover enters zone C: the base runs World's device flow, sends the link and code to the operator's phone over the mesh (the only place to approve; the dashboard shows only who is waiting), and validates the ID token itself (RS256, issuer, audience, `auth_time` within this attempt, a World `acr`, `amr` with `pop`) before issuing a 10 s single-use approval | [`src/base/world.ts:57`](src/base/world.ts#L57) (`verifyHuman`), [`:79`](src/base/world.ts#L79) (validation), [`src/base/main.ts:195`](src/base/main.ts#L195), [`WORLD_FEEDBACK.md`](WORLD_FEEDBACK.md) |
| **ENSv2** | The fleet is a namespace on Sepolia: a subname per robot, the base and each operator, each with its own `PermissionedResolver`, a role, an expiry, and for engines a signed mesh invite (`eth.meshrover-demo.role`, `.invite`, `.members`; ENSIP-26 `agent-context` and `agent-endpoint[web]` on robots). The base reads the roster every 60 s, caches it and relays it over the mesh; `authorize()` checks expiry, role and mesh key on both the base and the rover | [`contracts/script/Fleet.s.sol:191`](contracts/script/Fleet.s.sol#L191), [`src/base/roster.ts:35`](src/base/roster.ts#L35), [`src/protocol.ts:138`](src/protocol.ts#L138) |
| **Offline Protocol** | The mesh: each rover and the base drive their own engine through its local API; rover B reaches the base only through rover A; phones join over Bluetooth | [`src/engine.ts:9`](src/engine.ts#L9), [`src/base/main.ts:46`](src/base/main.ts#L46), [`src/sim/main.ts:46`](src/sim/main.ts#L46), [`operator-app/App.tsx`](operator-app/App.tsx) |

The safety checks every rule above depends on are in
[`src/protocol.ts`](src/protocol.ts): `parseDecision` (line 61),
`acceptDecision` (74), `authorize` (138) and `acceptApproval` (178), each with
tests for its reject paths.

**Revocation is not instant.** A rover enforces cached expiries offline, but
an `unregister` only reaches it at its next roster refresh.

## Where it's deployed

**Dashboard:** [meshrover.app](https://meshrover.app) (Cloudflare)

**0G Galileo (chain 16602)**

- `EpisodeAnchor`: [`0x8530Ec9B37EDc064527c5Dd20BAFE264F78cAF67`](https://chainscan-galileo.0g.ai/address/0x8530Ec9B37EDc064527c5Dd20BAFE264F78cAF67)
- An anchor transaction: [`0x4b33fb2c…a096b5c`](https://chainscan-galileo.0g.ai/tx/0x4b33fb2c653cebb44d3785b4e2799d63763ec3d8f33823e1790ce9449a096b5c)
- A 0G Storage root: `0x1fe2417df68ab43bc14e87b009f6211da26d3cb63428256e7ae719e7f1232818`
  (`https://indexer-storage-testnet-turbo.0g.ai/file?root=<root>`)

**Sepolia (ENSv2)**

- Fleet name `meshrover-demo.eth`; its registry
  `0xb8c8510f6BED87bc161530C83BBF5dd0272c1673`, resolver
  `0xe68B2433829788B9083079D9ae4035b96f2a78e7`
- Subnames and their resolvers: `rover-a`
  `0xDAd9dE70A9c3E21E2182C87428641665949C29B1`, `rover-b`
  `0x4A403308cD9A72544D105A56046790EB695CdFA1`, `base`
  `0xF47359fD689954ACBf2d149d84A1977303Bae461`, `alice` (supervisor)
  `0xD83bcf66377F9F827b608f8B09247162f461eF34`, `ravi-contractor` (operator,
  expired) `0x5c01d6Ad77B6aF1902A8Bc8b0290C2dF6b5caE4c`

## Repo layout

```
src/
  protocol.ts     message types and the checks every rule above depends on
  engine.ts       client for an engine's local API (JSON-RPC over a WebSocket)
  base/           the base: engine, 0G, World, ENS roster, episode record
  sim/            warehouse map, camera frames, safety camera, rovers (one engine each)
web/              dashboard: live view, roster, anchors, replay
contracts/        Foundry: EpisodeAnchor and its tests, the ENSv2 fleet setup script
operator-app/     React Native operator app: status and approvals over Bluetooth
config/           engine config
spikes/           the engine launcher and early experiments
WORLD_FEEDBACK.md World integration debrief
```

## Setup

You need a Mac (the base, both rovers and the dashboard run on it), Node 22 or
later, Python 3, Foundry, `jq` and `ffmpeg`, and an iPhone or Android phone for
the operator app. No router or LAN is needed.

1. Install:

   ```sh
   npm install && npm --prefix web install
   python3 -m venv .venv && .venv/bin/pip install offline-protocol-sdk==0.32.0
   cd contracts && forge install foundry-rs/forge-std --no-git && cd ..
   ```

2. Secrets, on the base only: copy `.env.example` to `.env` and fill in the 0G
   Router key, World's client ID and secret, and `KEYSTORE_PASSWORD` for a
   Foundry keystore named `base` (`cast wallet import base --interactive`),
   which signs the episode record. `web/` never reads `.env`.

3. Allow Bluetooth for the terminal app that runs the engines (System
   Settings → Privacy & Security → Bluetooth), and the camera for the one that
   runs the simulator.

4. Run, each in its own terminal:

   ```sh
   spikes/engines.sh    # three engines on loopback: base (with Bluetooth), rover-a, rover-b
   npm run base         # the base; writes episodes/<ep>/base.jsonl
   npm run sim          # both rovers (ROVERS=rover-a for one, CAMERA=none for drawn frames only)
   npm run web          # the dashboard on http://localhost:5173
   ```

   Ctrl-C on `npm run base` ends the episode: it uploads `base.jsonl` to 0G
   Storage and anchors it on Galileo (`npm run record -- <ep>` resumes it).

5. The operator app: see [`operator-app/README.md`](operator-app/README.md).

6. Operators: `npm run enroll -- alice.meshrover-demo.eth` runs World's device
   flow once and maps that World ID to the fleet name, privately on the base.

7. The ENS fleet: [`contracts/script/Fleet.s.sol`](contracts/script/Fleet.s.sol)
   (`commit()`, then `run()` a minute later, then `members()` with the engines'
   invites from `eval "$(npm run -s invites)"`). Try it on an anvil fork of
   Sepolia first.

Tests: `npm test`, `npm run typecheck`, `cd contracts && forge test`.
