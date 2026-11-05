// S3 (storage half): upload a small JSONL to 0G Storage on Galileo, then read
// it back by root over the indexer's plain HTTP (what a browser would do) and
// through the SDK. The signer is the Foundry keystore `base`, decrypted here.
// Run: KEYSTORE_PASSWORD=... npx tsx spikes/s3-storage.ts
import { readFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const RPC = process.env.GALILEO_RPC_URL ?? 'https://0g-galileo-testnet.drpc.org'; // evmrpc-testnet.0g.ai served a stale head on 2026-11-05
const INDEXER = 'https://indexer-storage-testnet-turbo.0g.ai';
const keystore = readFileSync(join(homedir(), '.foundry/keystores', process.env.KEYSTORE ?? 'base'), 'utf8');
const provider = new JsonRpcProvider(RPC);
const signer = (await Wallet.fromEncryptedJson(keystore, process.env.KEYSTORE_PASSWORD ?? '')).connect(provider);
const [balance, fee, net] = await Promise.all([provider.getBalance(signer.address), provider.getFeeData(), provider.getNetwork()]);
console.log('base', signer.address, 'chain', net.chainId, 'balance', balance, 'gasPrice', fee.gasPrice);

const text = JSON.stringify({ kind: 'spike', episode: 'ep-s3', t: Date.now() }) + '\n';
const indexer = new Indexer(INDEXER);
const t0 = Date.now();
const [tx, err] = await indexer.upload(new MemData(Buffer.from(text)), RPC, signer as any);
if (err) throw err;
const root = 'rootHash' in tx ? tx.rootHash : tx.rootHashes[0]!;
console.log('uploaded in', Date.now() - t0, 'ms', tx);

const http = await fetch(`${INDEXER}/file?root=${root}`);
const got = await http.text();
console.log('indexer HTTP', http.status, http.headers.get('access-control-allow-origin'), 'matches:', got === text);

const out = join(mkdtempSync(join(tmpdir(), 's3-')), 'ep.jsonl');
const dlErr = await indexer.download(root, out, true);
console.log('SDK download', dlErr ?? 'ok', 'matches:', !dlErr && readFileSync(out, 'utf8') === text);
