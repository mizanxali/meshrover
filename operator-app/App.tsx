// SPDX-License-Identifier: AGPL-3.0-only
// The operator's phone. It joins the fleet's mesh over Bluetooth only (the
// base engine is the one peer in range) and needs no internet for that:
// it finds the base by service discovery, opens a sealed session with one
// direct message, then subscribes to `fleet.status` (each rover's state, as
// the base last heard it) and `fleet.approvals` (rovers waiting at a zone
// gate). Approving opens World's link in the browser, over the phone's own
// mobile data; the base validates the result, never this app.
import { MeshServices, OfflineProtocol } from '@offline-protocol/mesh-sdk';
import { useEffect, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Status = { robot: string; episode: string; state: string; reason: string; checkpoint?: string; request_id?: string; t_ms: number };
type Card = { robot: string; zone: string; link: string; user_code: string; deadline: number };

const COLORS: Record<string, string> = { DRIVING: '#2e9d4f', AWAITING_DECISION: '#d89a00', SAFE_STOPPED: '#d0342c', AWAITING_APPROVAL: '#6a4cc7' };
// Only World's own sign-in pages: a card is shown to a human, so a link elsewhere is refused.
const WORLD = /^https:\/\/(sandbox\.)?auth\.world\.org\//;
const RETRY_MS = 5000;

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

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    let provider: string | null = null;
    const mine = new Set<string>(); // our subscription IDs

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
          provider = await Promise.race([found.then((e) => e.provider_peer_id as string), sleep(RETRY_MS).then(() => null)]);
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
    return () => clearInterval(t);
  }, []);

  const ago = (ms: number) => `${Math.max(0, Math.round((now - ms) / 1000))} s ago`;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen}>
        <ScrollView contentContainerStyle={s.body}>
          <Text style={s.h1}>Mesh Rover operator</Text>
          <Text style={s.dim}>Mesh over Bluetooth only · {link}{base ? ` · base ${short(base)}` : ''}</Text>

          {cards.map((c) => (
            <View key={c.robot} style={s.card}>
              <Text style={s.h2}>{c.robot} wants to enter zone {c.zone}</Text>
              <Text>
                Code <Text style={s.bold}>{c.user_code}</Text> · {Math.max(0, Math.round((c.deadline - now) / 1000))} s left
              </Text>
              {WORLD.test(c.link) ? (
                <Pressable style={s.button} onPress={() => Linking.openURL(c.link)}>
                  <Text style={s.buttonText}>Approve with World ID</Text>
                </Pressable>
              ) : (
                <Text style={s.bad}>Refused: this link is not World's ({c.link.slice(0, 40)})</Text>
              )}
              <Text style={s.dim}>To refuse, decline in World App or let it expire. The rover stays put.</Text>
            </View>
          ))}

          <Text style={s.h2}>Rovers</Text>
          {Object.values(rovers).length === 0 && <Text style={s.dim}>nothing heard yet</Text>}
          {Object.values(rovers).map((r) => (
            <View key={r.robot} style={s.rover}>
              <Text style={s.bold}>{r.robot}</Text>
              <Text style={[s.state, { backgroundColor: COLORS[r.state] ?? '#888' }]}>{r.state.replace('_', ' ')}</Text>
              <Text>{r.reason}</Text>
              {r.request_id ? <Text style={s.dim}>0G request {r.request_id}</Text> : null}
              <Text style={s.dim}>as the base heard it {ago(r.t_ms)} · {r.episode}</Text>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 16, gap: 8 },
  h1: { fontSize: 22, fontWeight: '700', color: '#111' },
  h2: { fontSize: 16, fontWeight: '600', marginTop: 8, color: '#111' },
  dim: { color: '#666', fontSize: 13 },
  bold: { fontWeight: '700', color: '#111' },
  bad: { color: '#d0342c' },
  card: { borderWidth: 2, borderColor: '#6a4cc7', borderRadius: 10, padding: 12, gap: 6 },
  button: { backgroundColor: '#111', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
  rover: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12, gap: 4 },
  state: { alignSelf: 'flex-start', color: '#fff', fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
});
