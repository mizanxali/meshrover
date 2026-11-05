// One decision from a 0G vision model through the Router, in `verified` trust
// mode. Anything short of a TEE-verified reply naming an offered action is an
// error, never a guess: the rover stops.
import { BASE_TIMEOUT_MS, type DecideRequest, parseDecision } from '../protocol.ts';

const REAL_ROUTER = 'https://router-api.0g.ai/v1';
const ROUTER = process.env.ZG_ROUTER_URL || REAL_ROUTER;
/** Only when ZG_ROUTER_URL names spikes/mock-router.ts, for building while 0G is down. Never a fallback. */
export const MOCK = ROUTER !== REAL_ROUTER;
const MODEL = MOCK ? 'mock' : process.env.ZG_VISION_MODEL || 'qwen3-vl-plus';

/** What `tee_verified` promises depends on the model's tier, so it travels with every decision. */
const TIERS: Record<string, string> = {
  TeeML: 'TeeML: the model runs inside the enclave and signs its replies',
  TeeTLS: 'TeeTLS: the enclave proxies to an upstream provider; the connection is attested, the model run is not',
};

/**
 * At startup: the model must still be on the Router, take images and be TEE-attested.
 * Model IDs come and go, so a written-down ID is checked, never trusted.
 */
export async function checkModel(): Promise<{ model: string; verifiability: string }> {
  const res = await fetch(`${ROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
  const m = ((await res.json()) as any)?.data?.find((x: any) => x.id === MODEL);
  if (!m) throw new Error(`${MODEL} is not on the 0G Router any more (set ZG_VISION_MODEL)`);
  if (!m.architecture?.input_modalities?.includes('image')) throw new Error(`${MODEL} does not take images`);
  if (MOCK) return { model: MODEL, verifiability: 'MOCK: a local stand-in for the 0G Router; nothing is attested, nothing is 0G' };
  if (m.tee_attested !== true || !TIERS[m.verifiability]) throw new Error(`${MODEL} is not TEE-attested (${m.verifiability})`);
  return { model: MODEL, verifiability: TIERS[m.verifiability]! };
}

const SYSTEM = `You drive a warehouse rover. The image is its forward camera at a checkpoint.
It shows up to three regions: LEFT, AHEAD and RIGHT. A dark opening is an aisle; orange shelving means there is no aisle that way; a brown PALLET box blocks that aisle; a blue ROVER is another robot in the way, which may move off (stop waits for it).
proceed = drive AHEAD, turn_left = take the LEFT aisle, turn_right = take the RIGHT aisle, turn_around = go back the way you came, stop = hold here.
Some frames also have a SAFETY CAM panel on the right: a live photo from the rover's real camera. If a hand or an object is close to the lens, covering much of the picture, choose stop, whatever the drawn view shows. A person further back (the operator at the desk) is normal.
Never choose an aisle blocked by a pallet. If you are unsure, choose stop.
Reply with JSON {"action": "...", "reason": "..."} only. action must be one of the options given.`;

export type Decided = {
  action: DecideRequest['options'][number];
  reason: string;
  model: string;
  request_id: string; // x_0g_trace.request_id
  zg_res_key: string | null; // the chatID for an independent processResponse check
  provider: string | null;
  tee_verified: true;
  verifiability: string;
};

export async function decide(req: DecideRequest, key: string, verifiability: string): Promise<Decided | { error: string; request_id?: string }> {
  let res: Response;
  let body: any;
  try {
    res = await fetch(`${ROUTER}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(BASE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${MOCK ? 'mock' : key}`, // the real key goes only to the real Router
        'Content-Type': 'application/json', 'X-0G-Provider-Trust-Mode': 'verified' },
      body: JSON.stringify({
        model: MODEL,
        verify_tee: true,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: [
            { type: 'text', text: JSON.stringify({ checkpoint: req.checkpoint, options: req.options, pose: req.pose }) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${req.frame_jpeg_b64}` } },
          ] },
        ],
      }),
    });
    body = await res.json();
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { error: `0G unreachable: ${err.name === 'TimeoutError' ? `no reply in ${BASE_TIMEOUT_MS / 1000} s` : (err.cause?.code ?? err.message)}` };
  }
  const trace = body?.x_0g_trace;
  const request_id = typeof trace?.request_id === 'string' ? trace.request_id : undefined;
  if (!res.ok) return { error: `0G answered HTTP ${res.status}`, request_id };
  if (!request_id) return { error: '0G reply has no request ID' };
  if (trace.tee_verified !== true) return { error: '0G reply not TEE-verified', request_id };
  const d = parseDecision(body?.choices?.[0]?.message?.content, req.options);
  if (!d) return { error: '0G reply is not an offered action', request_id };
  return {
    ...d,
    model: typeof body.model === 'string' ? body.model : MODEL,
    request_id,
    zg_res_key: res.headers.get('ZG-Res-Key'),
    provider: typeof trace.provider === 'string' ? trace.provider : null,
    tee_verified: true,
    verifiability,
  };
}
