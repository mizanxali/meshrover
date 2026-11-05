// SPDX-License-Identifier: AGPL-3.0-only
// S4: World ID device flow end to end. Prints the link to open on a phone,
// polls the token endpoint, validates the ID token, prints acr/amr/auth_time.
// Never prints `sub`. Run: npx tsx spikes/s4-world.ts [acr]
//   .env: WORLD_CLIENT_ID, WORLD_CLIENT_SECRET, WORLD_CLIENT_AUTH=basic|post (as chosen in the portal)
import { createRemoteJWKSet, jwtVerify } from 'jose';

process.loadEnvFile();
const ISSUER = process.env.WORLD_ISSUER ?? 'https://auth.world.org';
const { WORLD_CLIENT_ID: id, WORLD_CLIENT_SECRET: secret, WORLD_CLIENT_AUTH: auth = 'basic' } = process.env;
if (!id || !secret) throw new Error('WORLD_CLIENT_ID and WORLD_CLIENT_SECRET must be in .env');
const acr = process.argv[2]; // e.g. https://world.org/oidc/acr/orb

const conf: any = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
const jwks = createRemoteJWKSet(new URL(conf.jwks_uri));

async function post(url: string, form: Record<string, string>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (auth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(id!)}:${encodeURIComponent(secret!)}`).toString('base64')}`;
  else Object.assign(form, { client_id: id!, client_secret: secret! });
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(form) });
  return { status: res.status, body: await res.json() as any };
}

const started = Math.floor(Date.now() / 1000);
const da = await post(conf.device_authorization_endpoint, { client_id: id, scope: 'openid', ...(acr && { acr_values: acr }) });
console.log('device_authorization', da.status, { ...da.body, device_code: da.body.device_code && '<redacted>' });
if (da.status !== 200) process.exit(1);
console.log('\nOpen on the phone:', da.body.verification_uri_complete, '\n');

let interval = (da.body.interval ?? 5) * 1000;
const deadline = Date.now() + 120_000; // the demo's 2-minute approval window
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval));
  const t = await post(conf.token_endpoint, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: da.body.device_code, client_id: id });
  const err = t.body.error;
  if (err === 'authorization_pending') { process.stdout.write('.'); continue; }
  if (err === 'slow_down') { interval += 5000; continue; }
  if (err) { console.log('\nstopped:', t.status, t.body); process.exit(2); }
  const { payload, protectedHeader } = await jwtVerify(t.body.id_token, jwks, { issuer: conf.issuer, audience: id, algorithms: ['RS256'] });
  const fresh = typeof payload.auth_time === 'number' && payload.auth_time >= started - 5;
  console.log('\nvalid ID token:', { alg: protectedHeader.alg, iss: payload.iss, acr: payload.acr, amr: payload.amr,
    auth_time: payload.auth_time, auth_time_in_this_attempt: fresh, exp: payload.exp, sub: '<not printed>' });
  console.log('token response keys:', Object.keys(t.body));
  process.exit(0);
}
console.log('\nwindow expired');
process.exit(2);
