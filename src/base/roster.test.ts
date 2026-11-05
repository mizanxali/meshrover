import assert from 'node:assert/strict';
import test from 'node:test';
import { FLEET, key, readRoster } from './roster.ts';

const REGISTRY = '0x00000000000000000000000000000000000000aa';
const NONE = '0x0000000000000000000000000000000000000000';
const future = BigInt(Math.floor(Date.now() / 1000) + 3600);

/** A stand-in for viem's client: text records by name and key, expiries by label. */
function fake(texts: Record<string, string>, expiries: Record<string, bigint>, registry = REGISTRY) {
  return {
    getEnsText: async ({ name, key: k }: { name: string; key: string }) => texts[`${name} ${k}`] ?? null,
    readContract: async ({ functionName, args }: { functionName: string; args: [string] }) =>
      functionName === 'getSubregistry' ? registry : (expiries[args[0]] ?? 0n),
  } as any;
}
const parse = async (blob: string) => (blob === 'good' ? 'off1good' : Promise.reject(new Error('bad invite')));

test('readRoster reads members under their normalized names, keys from their invites', async () => {
  assert.equal(key('role'), 'eth.meshrover-demo.role');
  const r = await readRoster(fake({
    [`${FLEET} ${key('members')}`]: 'Rover-A, alice',
    [`rover-a.${FLEET} ${key('role')}`]: 'robot',
    [`rover-a.${FLEET} ${key('invite')}`]: 'good',
    [`alice.${FLEET} ${key('role')}`]: 'supervisor',
    [`alice.${FLEET} ${key('invite')}`]: 'forged',
  }, { 'rover-a': future, alice: future }), parse);
  assert.deepEqual(r, {
    [`rover-a.${FLEET}`]: { expiry: Number(future) * 1000, role: 'robot', address: 'off1good' },
    [`alice.${FLEET}`]: { expiry: Number(future) * 1000, role: 'supervisor' }, // a bad invite: no key
  });
});

test('an expired member keeps its cached role with the chain expiry; an expired fleet has no members', async () => {
  const ravi = `ravi-contractor.${FLEET}`;
  const texts = { [`${FLEET} ${key('members')}`]: 'ravi-contractor' }; // expired: its records read as unset
  const r = await readRoster(fake(texts, { 'ravi-contractor': 1000n }), parse, { [ravi]: { role: 'operator', expiry: 9e15 } });
  assert.deepEqual(r, { [ravi]: { role: 'operator', expiry: 1_000_000 } });
  assert.deepEqual(await readRoster(fake(texts, {}, NONE), parse, r), {});
});

test('readRoster throws rather than return a partial roster', async () => {
  await assert.rejects(readRoster(fake({}, {}), parse), /no eth.meshrover-demo.members record/);
  await assert.rejects(readRoster(fake({ [`${FLEET} ${key('members')}`]: 'x.rover-a' }, {}), parse), /not a single label/);
});
