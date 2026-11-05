// The operator's phone. It joins the fleet's mesh over Bluetooth only (the
// base engine is the one peer in range) and needs no internet for that:
// it finds the base by service discovery, opens a sealed session with one
// direct message, then subscribes to `fleet.status` (each rover's state, as
// the base last heard it) and `fleet.approvals` (rovers waiting at a zone
// gate). Approving opens World's link in the browser, over the phone's own
// mobile data; the base validates the result, never this app.
// A phone out of the Mac's Bluetooth range reaches the base through another
// phone. The mesh line shows it: how many hops away the base answers
// discovery from (0 direct, 1 through one relay), this phone's Bluetooth
// links, and how many messages it has carried for others.
import { MeshServices, OfflineProtocol } from '@offline-protocol/mesh-sdk';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Status = { robot: string; episode: string; state: string; reason: string; checkpoint?: string; request_id?: string; t_ms: number };
type Card = { robot: string; zone: string; link: string; user_code: string; deadline: number };

const APPROVAL_WINDOW_MS = 120_000; // the base's window for World ID (src/protocol.ts), for the countdown bar
// Only World's own sign-in pages: a card is shown to a human, so a link elsewhere is refused.
const WORLD = /^https:\/\/(sandbox\.)?auth\.world\.org\//;
const RETRY_MS = 5000;
const MESH_MS = 15_000; // discovery again, for the base's current hop count

const protocol = new OfflineProtocol({
  appId: 'meshrover',
  profile: 'default',
  transports: { ble: { enabled: true }, internet: { enabled: false }, wifiDirect: { enabled: false } },
});
const services = new MeshServices();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-4)}`;
const parse = <T,>(s: string): T | null => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

async function permissions() {
  if (Platform.OS !== 'android') return; // iOS asks on first Bluetooth use (Info.plist)
  const P = PermissionsAndroid.PERMISSIONS;
  const wanted = (Platform.Version as number) >= 31 ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT, P.BLUETOOTH_ADVERTISE] : [P.ACCESS_FINE_LOCATION];
  const got = await PermissionsAndroid.requestMultiple(wanted);
  const denied = wanted.filter((p) => got[p] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length) throw new Error(`Bluetooth permission denied: ${denied.join(', ')}`);
}

/** Resolves with the first event of `type` that `match` accepts. */
const next = (type: string, match: (e: any) => boolean) =>
  new Promise<any>((ok) => {
    const l = (e: any) => {
      if (match(e)) (protocol.off(type as any, l), ok(e));
    };
    protocol.on(type as any, l);
  });

export default function App() {
  const [link, setLink] = useState('starting');
  const [base, setBase] = useState<string | null>(null);
  const [rovers, setRovers] = useState<Record<string, Status>>({});
  const [cards, setCards] = useState<Card[]>([]);
  const [now, setNow] = useState(Date.now());
  const [mesh, setMesh] = useState<{ hops?: number; links?: number; relayed?: number }>({});

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    let provider: string | null = null;
    const mine = new Set<string>(); // our subscription IDs

    protocol.on('service_discovered' as any, (e: any) => {
      if (e.service_id === 'fleet.status' && e.provider_peer_id === provider) setMesh((m) => ({ ...m, hops: e.hop_count }));
    });
    const meshTimer = setInterval(async () => {
      if (!provider) return;
      try {
        const [links, stats] = await Promise.all([protocol.getBLePeerCount(), protocol.getMeshRelayStats()]);
        setMesh((m) => ({ ...m, links, relayed: stats.forwarded }));
        await services.discoverServices('fleet.status');
      } catch {} // the line just keeps its last values
    }, MESH_MS);

    protocol.on('service_update_received' as any, (e: any) => {
      if (e.provider_peer_id !== provider || !mine.has(e.sub_id)) return;
      if (e.service_id === 'fleet.status') {
        const s = parse<Status>(e.body);
        if (s?.robot) setRovers((r) => ({ ...r, [s.robot]: s }));
      }
      if (e.service_id === 'fleet.approvals') setCards(parse<Card[]>(e.body) ?? []);
    });

    const subscribe = async (service: string, topic: string) => {
      for (;;) {
        try {
          const id = await services.subscribeService(provider!, service, topic, 'latest');
          mine.add(id);
          const end = await next('service_subscription_changed', (e) => e.sub_id === id && e.state === 'ended');
          mine.delete(id);
          setLink(`lost ${service} (${end.reason}), resubscribing`);
        } catch (err) {
          setLink(`subscribe ${service} failed: ${(err as Error).message}`);
        }
        await sleep(RETRY_MS);
      }
    };

    (async () => {
      try {
        await permissions();
        await protocol.start();
        // The base is whoever provides fleet.status within Bluetooth range.
        // ponytail: trusts the first provider found; pin the base's key from the ENS roster.
        setLink('looking for the base over Bluetooth');
        const found = next('service_discovered', (e) => e.service_id === 'fleet.status');
        while (!provider) {
          await services.discoverServices('fleet.status');
          provider = await Promise.race([
            found.then((e) => (setMesh((m) => ({ ...m, hops: e.hop_count })), e.provider_peer_id as string)),
            sleep(RETRY_MS).then(() => null),
          ]);
        }
        setBase(provider);
        // Service bodies are sealed only once a session exists; one direct message starts it.
        setLink('opening a sealed session');
        for (;;) {
          const id = await protocol.sendMessage({ recipient: provider, content: JSON.stringify({ v: 1, hello: 'operator' }) });
          const ok = await Promise.race([next('message_delivered', (e) => e.message_id === id).then(() => true), sleep(30_000).then(() => false)]);
          if (ok) break;
        }
        setLink('connected');
        void subscribe('fleet.status', 'rovers');
        void subscribe('fleet.approvals', 'pending');
      } catch (err) {
        setLink(`error: ${(err as Error).message}`);
      }
    })();
    return () => (clearInterval(t), clearInterval(meshTimer));
  }, []);

  const sec = (ms: number) => Math.max(0, Math.round(ms / 1000));
  const conn = link === 'connected' ? 'ok' : link.startsWith('error') ? 'bad' : 'warn';
  const list = Object.values(rovers).sort((a, b) => a.robot.localeCompare(b.robot));
  const hops = mesh.hops === undefined ? '—' : mesh.hops === 0 ? 'Direct' : `${mesh.hops} hop${mesh.hops > 1 ? 's' : ''}`;
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <SafeAreaView style={s.screen}>
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.row}>
            <Text style={s.h1}>Mesh Rover</Text>
            <View style={s.state}>
              <Dot color={TONE[conn]} pulse={conn === 'ok'} />
              <Text style={[s.stateText, { color: TONE[conn] }]}>{conn === 'ok' ? 'Connected' : conn === 'bad' ? 'Error' : 'Connecting'}</Text>
            </View>
          </View>

          <View style={s.panel}>
            <View style={s.panelHead}>
              <Text style={s.title}>Mesh link</Text>
              <Text style={s.dim}>Bluetooth only, no internet</Text>
            </View>
            {base ? (
              <>
                <View style={s.tiles}>
                  <Tile k="Base" v={hops} sub={mesh.hops ? 'through another phone' : mesh.hops === 0 ? 'in range' : 'measuring'} />
                  <Tile k="Bluetooth links" v={mesh.links === undefined ? '—' : String(mesh.links)} sub="this phone" />
                  <Tile k="Relayed" v={mesh.relayed === undefined ? '—' : String(mesh.relayed)} sub="for others" last />
                </View>
                <Text style={s.foot}>
                  Base <Text style={s.mono}>{short(base)}</Text>
                  {conn === 'ok' ? '' : ` · ${link}`}
                </Text>
              </>
            ) : (
              <View style={s.searching}>
                <ActivityIndicator color={C.text} />
                <Text style={s.searchingText}>{link.charAt(0).toUpperCase() + link.slice(1)}</Text>
              </View>
            )}
          </View>

          {cards.length > 0 && (
            <View style={s.sectionRow}>
              <Text style={s.section}>Approvals</Text>
              <Text style={[s.dim, { color: C.violet }]}>{cards.length} waiting</Text>
            </View>
          )}
          {cards.map((c) => {
            const left = Math.max(0, c.deadline - now);
            return (
              <View key={c.robot} style={s.card}>
                <View style={s.row}>
                  <Text style={s.cardTitle}>
                    {c.robot.split('.')[0]} wants to enter <Text style={{ color: C.violet }}>zone {c.zone}</Text>
                  </Text>
                  <Text style={[s.mono, { color: left < 20_000 ? C.amber : C.dim }]}>{sec(left)} s</Text>
                </View>
                <Text style={s.cardDim}>It holds at the gate until a supervisor approves with World ID.</Text>
                <View style={s.codeBox}>
                  <Text style={s.dim}>World code</Text>
                  <Text style={s.code}>{c.user_code}</Text>
                </View>
                <View style={s.meter}>
                  <View style={[s.meterFill, { width: `${(left / APPROVAL_WINDOW_MS) * 100}%` }]} />
                </View>
                {WORLD.test(c.link) ? (
                  <Pressable style={({ pressed }) => [s.button, pressed && { opacity: 0.8 }]} onPress={() => Linking.openURL(c.link)}>
                    <Text style={s.buttonText}>Approve with World ID</Text>
                  </Pressable>
                ) : (
                  <Text style={s.bad}>Refused: this link is not World's ({c.link.slice(0, 40)})</Text>
                )}
                <Text style={s.cardFoot}>To refuse, decline in World App or let it expire. The rover stays put.</Text>
              </View>
            );
          })}

          <View style={s.sectionRow}>
            <Text style={s.section}>Fleet</Text>
            {list.length > 0 && <Text style={s.dim}>{list.length} rover{list.length === 1 ? '' : 's'}</Text>}
          </View>
          {list.length === 0 && (
            <View style={[s.panel, s.empty]}>
              <Text style={s.emptyTitle}>No rovers heard yet</Text>
              <Text style={s.cardDim}>Rover status arrives from the base over the mesh once the session is up.</Text>
            </View>
          )}
          {list.map((r) => {
            const c = STATE[r.state]?.color ?? C.dim;
            const since = now - r.t_ms; // the base publishes on a change, so: time in this state
            return (
              <View key={r.robot} style={[s.panel, s.rover]}>
                <View style={s.row}>
                  <View style={s.avatar}>
                    <Text style={s.avatarText}>{r.robot.split('.')[0]!.replace(/^rover-/, '').toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.name}>{r.robot.split('.')[0]}</Text>
                    <Text style={s.dim} numberOfLines={1}>{r.episode}</Text>
                  </View>
                  <View style={s.state}>
                    <Dot color={c} pulse={r.state === 'DRIVING'} />
                    <Text style={[s.stateText, { color: c }]}>{STATE[r.state]?.name ?? r.state}</Text>
                  </View>
                </View>
                <Text style={s.reason}>{r.reason}</Text>
                <View style={s.divider} />
                <View style={s.row}>
                  <Text style={[s.mono, { flex: 1 }]} numberOfLines={1} ellipsizeMode="middle">
                    {r.request_id ? `0G ${r.request_id}` : r.checkpoint ? `at ${r.checkpoint}` : ''}
                  </Text>
                  <Text style={s.mono}>for {sec(since)} s</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) return;
    const a = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [pulse, v]);
  return <Animated.View style={[s.dot, { backgroundColor: color, opacity: pulse ? v : 1 }]} />;
}

function Tile({ k, v, sub, last }: { k: string; v: string; sub: string; last?: boolean }) {
  return (
    <View style={[s.tile, last && { borderRightWidth: 0 }]}>
      <Text style={s.dim}>{k}</Text>
      <Text style={s.tileV}>{v}</Text>
      <Text style={s.tileSub}>{sub}</Text>
    </View>
  );
}

// The dashboard's palette: black surfaces, white text, colour only for state.
const C = {
  bg: '#000', panel: '#0a0a0a', line: '#222', line2: '#333',
  text: '#fff', dim: '#a0a0a0', faint: '#666', green: '#22c55e', amber: '#f5a524', red: '#f04444', violet: '#a78bfa',
};
const TONE = { ok: C.green, warn: C.amber, bad: C.red };
const STATE: Record<string, { color: string; name: string }> = {
  DRIVING: { color: C.green, name: 'Driving' },
  AWAITING_DECISION: { color: C.amber, name: 'Awaiting 0G' },
  SAFE_STOPPED: { color: C.red, name: 'Safe-stopped' },
  AWAITING_APPROVAL: { color: C.violet, name: 'Awaiting human' },
};
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  body: { padding: 14, gap: 10, paddingBottom: 28 },
  h1: { color: C.text, fontSize: 24, fontWeight: '700', paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  state: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stateText: { fontSize: 13, fontWeight: '600' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  panel: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 4, overflow: 'hidden' },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line },
  title: { color: C.text, fontSize: 14, fontWeight: '600' },
  dim: { color: C.dim, fontSize: 12 },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 },
  section: { color: C.text, fontSize: 16, fontWeight: '600' },
  tiles: { flexDirection: 'row' },
  tile: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, borderRightWidth: 1, borderRightColor: C.line },
  tileV: { color: C.text, fontSize: 20, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  tileSub: { color: C.faint, fontSize: 11, marginTop: 1 },
  foot: { color: C.dim, fontSize: 12, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line },
  mono: { fontFamily: MONO, fontSize: 12, color: C.dim },
  searching: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  searchingText: { color: C.dim, fontSize: 14, flex: 1 },
  bad: { color: C.red, fontSize: 13 },
  card: { backgroundColor: C.panel, borderColor: C.violet, borderWidth: 1, borderRadius: 4, padding: 12, gap: 10 },
  cardTitle: { color: C.text, fontSize: 17, fontWeight: '600', flex: 1 },
  cardDim: { color: C.dim, fontSize: 13, lineHeight: 18 },
  codeBox: { backgroundColor: C.bg, borderRadius: 4, borderWidth: 1, borderColor: C.line2, paddingVertical: 10, alignItems: 'center', gap: 2 },
  code: { color: C.text, fontFamily: MONO, fontSize: 24, fontWeight: '700', letterSpacing: 3 },
  meter: { height: 2, backgroundColor: C.line2 },
  meterFill: { height: 2, backgroundColor: C.violet },
  button: { backgroundColor: C.text, borderRadius: 4, paddingVertical: 13, alignItems: 'center' },
  buttonText: { color: C.bg, fontWeight: '700', fontSize: 15 },
  cardFoot: { color: C.faint, fontSize: 12, textAlign: 'center' },
  empty: { padding: 14, gap: 4 },
  emptyTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  rover: { padding: 12, gap: 9 },
  avatar: { width: 32, height: 32, borderRadius: 4, borderWidth: 1, borderColor: C.line2, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: C.text, fontWeight: '700', fontSize: 14 },
  name: { color: C.text, fontSize: 15, fontWeight: '600' },
  reason: { color: C.dim, fontSize: 14, lineHeight: 19 },
  divider: { height: 1, backgroundColor: C.line },
});
