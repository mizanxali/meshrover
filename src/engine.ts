// A client for one offline-protocol-service engine's local API: JSON-RPC 2.0
// over a WebSocket on loopback. Events arrive as notifications whose params
// are the event object. The token is the one the engine wrote at startup.
import { readFileSync } from 'node:fs';

export type EngineEvent = { type: string; [k: string]: any };
export type Engine = Awaited<ReturnType<typeof connectEngine>>;

export async function connectEngine(name: string, port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`${name}: no engine on port ${port} (run spikes/engines.sh)`));
  });
  // Without its engine a process has no mesh at all; exiting is the honest stop.
  ws.onclose = () => {
    console.error(`${name}: engine connection closed`);
    process.exit(1);
  };

  let id = 0;
  const calls = new Map<number, { ok: (r: any) => void; fail: (e: Error) => void }>();
  const listeners = new Set<(e: EngineEvent) => void>();
  ws.onmessage = (f) => {
    const m = JSON.parse(String(f.data));
    if (m.id !== undefined) {
      const c = calls.get(m.id);
      calls.delete(m.id);
      if (m.error) c?.fail(new Error(`${m.error.data?.variant ?? m.error.code}: ${m.error.message}`));
      else c?.ok(m.result);
    } else if (m.method === 'event') for (const l of listeners) l(m.params);
  };

  const call = (method: string, params: object = {}) =>
    new Promise<any>((ok, fail) => {
      const n = ++id;
      calls.set(n, { ok, fail });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
    });
  const on = (l: (e: EngineEvent) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const waitFor = (match: (e: EngineEvent) => boolean, ms: number) =>
    new Promise<EngineEvent>((ok, fail) => {
      const t = setTimeout(() => (off(), fail(new Error(`${name}: timed out after ${ms} ms`))), ms);
      const off = on((e) => {
        if (match(e)) (clearTimeout(t), off(), ok(e));
      });
    });

  const token = readFileSync(`.run/${name}/token`, 'ascii').trim();
  const hello = await call('hello', { app_id: 'meshrover', client: name, token });
  return { address: hello.local_address as string, call, on, waitFor };
}
