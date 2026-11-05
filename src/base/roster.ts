// SPDX-License-Identifier: AGPL-3.0-only
// The fleet roster, read from ENSv2 on Sepolia. Our text record keys sit
// under the fleet name reversed (ENSIP-5 service keys): `eth.meshrover-demo.*`.
// The fleet name's `members` record lists the labels; it is only an index. For
// each one the fleet's own registry gives the expiry, and the subname's own
// resolver gives `role` and `invite` (the member's mesh invite, from which the
// mesh address comes). Public data only: the base and the dashboard both
// read it, and rovers get it from the base over the mesh, never from a chain.
import { http, createPublicClient, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import { ROLES, type Role, type Roster } from '../protocol.ts';

export const FLEET = 'meshrover-demo.eth';
/** A text record key in the fleet's own namespace, e.g. `eth.meshrover-demo.role`. */
export const key = (k: 'members' | 'role' | 'invite') => `${FLEET.split('.').reverse().join('.')}.${k}`;
export const SEPOLIA_RPC = 'https://rpc.sepolia.ethpandaops.io';
// ENSv2's .eth registry on Sepolia, a system contract. The fleet's registry is read from it.
const ETH_REGISTRY = '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4';
const NONE = '0x0000000000000000000000000000000000000000';
const abi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function findExpiry(string label) view returns (uint64)',
]);

export const sepoliaClient = (rpc = SEPOLIA_RPC) => createPublicClient({ chain: sepolia, transport: http(rpc) });
type Client = ReturnType<typeof sepoliaClient>;

/**
 * Every member the `members` record lists, in its order, under its normalized
 * name. Once a name expires its resolver reads as unset, so its role and key
 * are the ones in `previous` (the last read) and its expiry is the chain's.
 * An expired fleet name has no registry, so no members. Any failed read
 * throws, so a caller never mixes a partial read into its roster.
 */
export async function readRoster(client: Client, parseInvite: (blob: string) => Promise<string>, previous: Roster = {}): Promise<Roster> {
  const text = (name: string, k: Parameters<typeof key>[0]) => client.getEnsText({ name, key: key(k) });
  const registry = await client.readContract({ address: ETH_REGISTRY, abi, functionName: 'getSubregistry', args: [FLEET.split('.')[0]!] });
  if (registry === NONE) return {};
  const labels = (await text(FLEET, 'members'))?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  if (!labels.length) throw new Error(`${FLEET} has no ${key('members')} record`);
  const members = await Promise.all(labels.map(async (raw) => {
    const name = normalize(`${raw}.${FLEET}`);
    const label = name.slice(0, -FLEET.length - 1);
    if (!label || label.includes('.')) throw new Error(`${key('members')} lists ${JSON.stringify(raw)}, not a single label`);
    const [expiry, role, invite] = await Promise.all([
      client.readContract({ address: registry, abi, functionName: 'findExpiry', args: [label] }),
      text(name, 'role'),
      text(name, 'invite'),
    ]);
    const m = { expiry: Number(expiry) * 1000, ...(ROLES.includes(role as Role) ? { role: role as Role } : {}) };
    if (!m.role) return [name, Date.now() >= m.expiry ? { ...previous[name], ...m } : m] as const;
    // A bad invite leaves the member without a key, so nothing it sends counts.
    const address = invite ? await parseInvite(invite).catch(() => undefined) : undefined;
    return [name, { ...m, ...(address ? { address } : {}) }] as const;
  }));
  return Object.fromEntries(members);
}
