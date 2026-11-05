// Prints each engine's mesh invite as shell exports, for the `invite`
// records that contracts/script/Fleet.s.sol writes. The invites carry only
// public keys and addresses.
// Run: eval "$(npm run -s invites)"   (engines up)
import { connectEngine } from '../engine.ts';

for (const [name, port] of [['base', 7201], ['rover-a', 7202], ['rover-b', 7203]] as const) {
  const engine = await connectEngine(name, port);
  const invite = await engine.call('create_invite', { petname: name, sign: true });
  console.log(`export INVITE_${name.replace('-', '_').toUpperCase()}=${invite}`);
}
process.exit(0);
