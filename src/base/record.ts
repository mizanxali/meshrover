// SPDX-License-Identifier: AGPL-3.0-only
// The record, written after an episode ends: the episode file goes to 0G
// Storage, then its root and counts go to EpisodeAnchor on Galileo. No rover
// reads either. Offline, it retries until the internet is back. Progress is
// kept in episodes/<ep>/record.json, so a rerun resumes where it stopped.
// Run: npm run record -- <episode>   (KEYSTORE_PASSWORD in .env)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { type BaseWallet, Contract, type ContractTransactionResponse, JsonRpcProvider, Wallet, ZeroHash, id, namehash } from 'ethers';

export const ANCHOR = '0x8530Ec9B37EDc064527c5Dd20BAFE264F78cAF67';
export const FLEET = 'meshrover-demo.eth';
const INDEXER = 'https://indexer-storage-testnet-turbo.0g.ai';
const ABI = [
  'function base() view returns (address)',
  'function rootOf(bytes32) view returns (bytes32)',
  'function anchor(bytes32 fleet, bytes32 episodeId, bytes32 storageRoot, uint32 decisions, uint32 safeStops, uint32 approvals, uint32 denials)',
];
const RETRY_MS = 15_000;

/** A reason never to anchor this episode: retrying won't change it. */
class Refused extends Error {}

/** The episode file → the counts to anchor. Refuses a mock run, an empty file, or another episode's entries. */
export function summarize(episode: string, text: string) {
  if (episode.endsWith('-mock')) throw new Refused(`${episode} ran on the mock Router: its decisions are not from 0G`);
  const entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  if (!entries.length) throw new Refused(`${episode} has no entries`);
  if (entries.some((e) => e.episode !== episode)) throw new Refused(`${episode}'s file holds another episode's entries`);
  if (entries.some((e) => String(e.request_id ?? '').startsWith('mock-'))) throw new Refused(`${episode} holds mock decisions`);
  const count = (kind: string) => entries.filter((e) => e.kind === kind).length;
  return { decisions: count('decision'), safeStops: count('safe_stop'), approvals: count('approval'), denials: count('denied') };
}

export async function loadSigner() {
  const pw = process.env.KEYSTORE_PASSWORD;
  if (pw === undefined) throw new Error('KEYSTORE_PASSWORD missing from .env (the Foundry keystore `base` signs the record)');
  return Wallet.fromEncryptedJson(readFileSync(join(homedir(), '.foundry/keystores/base'), 'utf8'), pw);
}

/** The first Galileo RPC whose head is under a minute old. One once served a frozen head and sat on sent transactions. */
async function freshRpc() {
  const rpcs = [process.env.GALILEO_RPC_URL, 'https://0g-galileo-testnet.drpc.org', 'https://evmrpc-testnet.0g.ai'];
  for (const url of new Set(rpcs.filter((u): u is string => !!u))) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
      });
      const age = Date.now() / 1000 - parseInt(((await res.json()) as any).result.timestamp, 16);
      if (age < 60) return url;
      console.warn(`${url}: head is ${Math.round(age)} s old, skipping`);
    } catch {}
  }
  throw new Error('no Galileo RPC with a current head (offline?)');
}

type Progress = { root?: string; upload_tx?: string; anchor_tx?: string; counts?: ReturnType<typeof summarize> };

export async function record(episode: string, wallet: BaseWallet): Promise<Progress> {
  const dir = `episodes/${episode}`;
  const data = readFileSync(`${dir}/base.jsonl`);
  const counts = summarize(episode, data.toString('utf8'));
  const path = `${dir}/record.json`;
  const r: Progress = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const save = () => writeFileSync(path, JSON.stringify({ ...r, counts }, null, 2));

  for (let attempt = 1; ; attempt++) {
    try {
      const url = await freshRpc();
      const signer = wallet.connect(new JsonRpcProvider(url, 16602, { staticNetwork: true }));
      if (!r.root) {
        const [tx, err] = await new Indexer(INDEXER).upload(new MemData(data), url, signer as any);
        if (err) throw err;
        r.root = 'rootHash' in tx ? tx.rootHash : tx.rootHashes[0]!;
        r.upload_tx = 'txHash' in tx ? tx.txHash : tx.txHashes[0]!;
        save();
        console.log(`${episode}: on 0G Storage, root ${r.root}`);
      }
      const anchor = new Contract(ANCHOR, ABI, signer) as unknown as {
        base(): Promise<string>; rootOf(episodeId: string): Promise<string>; anchor(...args: unknown[]): Promise<ContractTransactionResponse>;
      };
      if ((await anchor.base()) !== signer.address) throw new Refused(`${signer.address} is not EpisodeAnchor's base`);
      const episodeId = id(episode); // keccak256 of the UTF-8 name
      const onChain: string = await anchor.rootOf(episodeId);
      if (onChain === ZeroHash) {
        const tx = await anchor.anchor(namehash(FLEET), episodeId, r.root, counts.decisions, counts.safeStops, counts.approvals, counts.denials);
        r.anchor_tx = tx.hash;
        save();
        await tx.wait(1, 120_000);
      } else if (onChain !== r.root) {
        throw new Refused(`${episode} is already anchored with another root, ${onChain}`);
      }
      console.log(`${episode}: anchored, https://chainscan-galileo.0g.ai/tx/${r.anchor_tx}`);
      return { ...r, counts };
    } catch (e) {
      if (e instanceof Refused) throw e;
      console.warn(`${episode}: record attempt ${attempt} failed (${(e as Error).message.slice(0, 200)}), retrying in ${RETRY_MS / 1000} s`);
      await new Promise((ok) => setTimeout(ok, RETRY_MS));
    }
  }
}

if (import.meta.main) {
  process.loadEnvFile();
  const episode = process.argv[2] || (() => { throw new Error('usage: npm run record -- <episode>'); })();
  await record(episode, await loadSigner());
}
