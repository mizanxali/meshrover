// SPDX-License-Identifier: AGPL-3.0-only
// S5 read-back: the fleet's text records through viem's built-in Sepolia
// Universal Resolver (no universalResolverAddress override).
// Run: npx tsx spikes/s5-read.ts [rpc-url]   (default: public Sepolia; pass http://127.0.0.1:8545 for an anvil fork)
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';

const client = createPublicClient({ chain: sepolia, transport: http(process.argv[2] ?? 'https://rpc.sepolia.ethpandaops.io') });
const fleet = `${process.env.FLEET_LABEL ?? 'meshrover-demo'}.eth`;
const reads: [string, string][] = [
  [fleet, 'fleet.members'],
  [`rover-a.${fleet}`, 'fleet.role'],
  [`rover-a.${fleet}`, 'agent-context'],
  [`nobody.${fleet}`, 'fleet.role'],
];
for (const [name, key] of reads) {
  const value = await client.getEnsText({ name: normalize(name), key }).catch((e) => `ERROR ${e.shortMessage ?? e}`);
  console.log(name, key, '=>', JSON.stringify(value));
}
