// The human checkpoint: World ID Agent Pass's device flow, run and validated
// entirely on the base (the client secret never leaves it). The operator opens
// the link on their own phone; the base polls, then checks the ID token itself:
// RS256 against World's JWKS, the exact issuer, our client ID as audience,
// expiry, an `auth_time` inside this attempt, a World `acr`, and an `amr` with
// `pop` (a World ID proof). A passkey sign-in (`["pop","user","mfa"]`) is
// accepted: World's team confirmed it suffices, and `auth_time` still pins it
// to this attempt.
//
// `(iss, sub)` → operator name is private to the base (.run/base/operators.json):
// `sub` is a pairwise ID and is never logged or published.
// Enroll an operator once: npm run enroll -- alice.meshrover-demo.eth
import { readFileSync, writeFileSync } from 'node:fs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { APPROVAL_WINDOW_MS } from '../protocol.ts';

const ACRS = ['orb', 'orb-face', 'selfie', 'selfie-face'].map((a) => `https://world.org/oidc/acr/${a}`);
const OPERATORS = '.run/base/operators.json';

export type Human = { iss: string; sub: string; acr: string; amr: string[]; auth_time: number };
/** What the operator needs to approve: shown on the dashboard and the phone. */
export type Card = { link: string; user_code: string; deadline: number };

// Read at call time, after the caller has loaded .env.
const env = () => {
  const { WORLD_CLIENT_ID: id, WORLD_CLIENT_SECRET: secret, WORLD_ISSUER: issuer = 'https://auth.world.org' } = process.env;
  if (!id || !secret) throw new Error('WORLD_CLIENT_ID and WORLD_CLIENT_SECRET must be in .env');
  return { id, secret, issuer };
};

let discovery: Promise<{ conf: any; jwks: ReturnType<typeof createRemoteJWKSet> }> | null = null;
const discover = (issuer: string) =>
  (discovery ??= fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json() as Promise<any>)
    .then((conf) => ({ conf, jwks: createRemoteJWKSet(new URL(conf.jwks_uri)) }))
    .catch((e) => { discovery = null; throw e; })); // offline at startup is fine: try again next time

// client_secret_basic, as registered in World's portal (it can't be changed later).
async function post(url: string, form: Record<string, string>) {
  const { id, secret } = env();
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`,
    },
    body: new URLSearchParams(form),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/**
 * One device-flow attempt: a validated, fresh World ID proof from whoever
 * completes it within the window, or why not. Never throws.
 */
export async function verifyHuman(onCard: (c: Card) => void, windowMs = APPROVAL_WINDOW_MS): Promise<Human | { denied: string }> {
  const started = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + windowMs;
  try {
    const { id, issuer } = env();
    const { conf, jwks } = await discover(issuer);
    const da = await post(conf.device_authorization_endpoint, { client_id: id, scope: 'openid' });
    if (da.status !== 200 || !da.body.device_code) return { denied: `World refused the request (HTTP ${da.status} ${da.body.error ?? ''})`.trim() };
    onCard({ link: da.body.verification_uri_complete, user_code: da.body.user_code, deadline });

    let interval = (da.body.interval ?? 5) * 1000;
    while (Date.now() + interval < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const t = await post(conf.token_endpoint, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: da.body.device_code, client_id: id });
      const err = t.body.error;
      if (process.env.WORLD_DEBUG) console.error(`poll: HTTP ${t.status} ${err ? `${err} ${t.body.error_description ?? ''}` : (t.body.id_token ? 'id_token' : JSON.stringify(Object.keys(t.body)))}`); // never the token itself
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { interval += 5000; continue; }
      if (err === 'access_denied') return { denied: 'the operator declined in World App' };
      if (err === 'expired_token') return { denied: 'the World ID request expired' };
      if (err || t.status !== 200 || typeof t.body.id_token !== 'string') return { denied: `World ended the request (HTTP ${t.status} ${err ?? ''})`.trim() };

      const { payload: p } = await jwtVerify(t.body.id_token, jwks, { issuer: conf.issuer, audience: id, algorithms: ['RS256'] });
      if (typeof p.sub !== 'string' || !p.sub) return { denied: 'ID token has no subject' };
      if (typeof p.auth_time !== 'number' || p.auth_time < started - 5) return { denied: 'ID token is not from this attempt' };
      if (typeof p.acr !== 'string' || !ACRS.includes(p.acr)) return { denied: `not a verified World ID (acr ${String(p.acr)})` };
      const amr = Array.isArray(p.amr) ? p.amr.filter((a): a is string => typeof a === 'string') : [];
      if (!amr.includes('pop')) return { denied: `not a World ID proof (amr ${amr.join(',')})` };
      return { iss: p.iss!, sub: p.sub, acr: p.acr, amr, auth_time: p.auth_time };
    }
    return { denied: `no approval within ${windowMs / 1000} s` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string }; code?: unknown };
    // a timeout is a DOMException whose code is a number
    if (typeof err.code === 'string' && err.code.startsWith('ERR_J')) return { denied: `ID token rejected: ${err.message}` }; // jose's errors
    return { denied: `World unreachable: ${err.name === 'TimeoutError' ? 'no reply in 10 s' : (err.cause?.code ?? err.message)}` };
  }
}

const key = (h: Pick<Human, 'iss' | 'sub'>) => `${h.iss} ${h.sub}`;
const operators = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(OPERATORS, 'utf8'));
  } catch {
    return {};
  }
};

/** The enrolled operator this World ID belongs to, if any. */
export const operatorOf = (h: Human): string | undefined => operators()[key(h)];

if (import.meta.main) {
  process.loadEnvFile();
  const name = process.argv[2];
  if (!name) throw new Error('usage: npm run enroll -- <fleet name, e.g. alice.meshrover-demo.eth>');
  const ENROLL_WINDOW_MS = 600_000; // no robot waits on an enrollment
  const h = await verifyHuman((c) => console.log(`Open on ${name}'s phone, within ${ENROLL_WINDOW_MS / 1000} s:\n  ${c.link}\n  (code ${c.user_code})`), ENROLL_WINDOW_MS);
  if ('denied' in h) {
    console.error(`not enrolled: ${h.denied}`);
    process.exit(1);
  }
  const all = operators();
  for (const k of Object.keys(all)) if (all[k] === name) delete all[k]; // one World ID per name
  all[key(h)] = name;
  writeFileSync(OPERATORS, JSON.stringify(all, null, 2), { mode: 0o600 });
  console.log(`enrolled ${name} (${h.acr}, amr ${h.amr.join(',')}); the World ID itself stays in ${OPERATORS}`);
}
