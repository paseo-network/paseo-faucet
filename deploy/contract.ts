import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createClient, Enum, type PolkadotClient } from 'polkadot-api';
import { getFakeTxCreator } from 'polkadot-api/tx-creator';
import { getWsProvider } from 'polkadot-api/ws';
import { hexToBytes, isAddressEqual, type Address } from 'viem';
import { operator, type Signer } from './keys.ts';
import { parsePlan } from './lib.ts';
import { DEVNET } from './network.ts';

const USAGE = `Deploys the faucet from the operator account, the sr25519 root account of MNEMONIC, which
has no Ethereum key: forge simulates contracts/script/Deploy.s.sol as the account's Ethereum
address, and this sends the simulated transactions to Paseo Asset Hub as Substrate extrinsics.

  tsx contract.ts sender
      Print the account's Ethereum address, for \`forge script --sender\`.
  tsx contract.ts deploy --plan <broadcast/Deploy.s.sol/420420417/dry-run/run-latest.json>
      Create the contract with Revive.instantiate_with_code, then make the simulation's calls in
      one Utility.batch_all of Revive.call, each with its dry run's weight and deposit plus half.

  --asset-hub <url,...>    Asset Hub endpoints, instead of Paseo's.
  --mock-signer <address>  Sign as the address with chopsticks' mock signature, on a fork.`;

/** The flag a reverted contract call returns. */
const REVERT = 1;

interface Weight {
  ref_time: bigint;
  proof_size: bigint;
}
interface ChainEvent {
  type: string;
  value: { type: string; value?: Record<string, unknown> };
}
interface Returned {
  flags: number;
  data: unknown;
}
/** A ReviveApi dry run of a creation (`T` holds the address) or of a call. */
interface DryRun<T> {
  weight_required: Weight;
  max_storage_deposit: { type: string; value: bigint };
  result: { success: true; value: T } | { success: false; value: unknown };
}
type Balances = { data: { free: bigint } };

const withHalf = (n: bigint) => n + n / 2n;
const weightWithHalf = (weight: Weight): Weight => ({ ref_time: withHalf(weight.ref_time), proof_size: withHalf(weight.proof_size) });
const charge = (deposit: { type: string; value: bigint }) => (deposit.type === 'Charge' ? deposit.value : 0n);
const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `0x${Buffer.from(v).toString('hex')}` : v));
const findEvent = (events: ChainEvent[], pallet: string, name: string) => events.find((e) => e.type === pallet && e.value.type === name)?.value;

function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function report(lines: string[]): void {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** A connection to Paseo Asset Hub through `endpoints`, which may be a fork of it. */
async function connect(endpoints: readonly string[]): Promise<PolkadotClient> {
  const client = createClient(getWsProvider([...endpoints]));
  try {
    const { genesisHash } = await client.getChainSpecData();
    if (genesisHash !== DEVNET.assetHubGenesis) throw new Error(`${endpoints[0]} is not Paseo Asset Hub (genesis ${genesisHash})`);
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function sender(client: PolkadotClient, who: string): Promise<void> {
  const address = (await client.getUnsafeApi().apis.ReviveApi.address(who)) as Address;
  output('sender', address);
  console.log(address);
}

async function deploy(client: PolkadotClient, who: string, signer: Signer, planPath: string): Promise<void> {
  const plan = parsePlan(JSON.parse(readFileSync(planPath, 'utf8')));
  const api = client.getUnsafeApi();
  const address = (await api.apis.ReviveApi.address(who)) as Address;
  if (!isAddressEqual(address, plan.sender)) throw new Error(`${who} is ${address}, but the plan was simulated as ${plan.sender}`);
  const nonce = Number(await api.apis.AccountNonceApi.account_nonce(who));
  if (nonce !== plan.nonce) throw new Error(`${who} is at nonce ${nonce}, but the plan creates the contract at nonce ${plan.nonce}: simulate again`);
  const before = ((await api.query.System.Account.getValue(who)) as Balances).data;

  // The creation code carries its constructor arguments, as an Ethereum creation does; the call data stays empty.
  const code = hexToBytes(plan.initcode);
  const data = new Uint8Array();
  const dry = (await api.apis.ReviveApi.instantiate(who, 0n, undefined, undefined, Enum('Upload', code), data, undefined)) as DryRun<{
    result: Returned;
    addr: Address;
  }>;
  if (!dry.result.success) throw new Error(`the creation fails: ${show(dry.result.value)}`);
  if (dry.result.value.result.flags & REVERT) throw new Error(`the constructor reverts: ${show(dry.result.value.result.data)}`);
  if (!isAddressEqual(dry.result.value.addr, plan.contract)) throw new Error(`the creation lands at ${dry.result.value.addr}, not ${plan.contract}`);
  const created = await api.tx.Revive.instantiate_with_code({
    value: 0n,
    weight_limit: weightWithHalf(dry.weight_required),
    storage_deposit_limit: withHalf(charge(dry.max_storage_deposit)),
    code,
    data,
    salt: undefined,
  }).createAndSubmit(signer);
  if (!created.ok) throw new Error(`the creation failed: ${show(created.dispatchError)}`);
  const instantiated = findEvent(created.events as ChainEvent[], 'Revive', 'Instantiated')?.value;
  if (!instantiated || !isAddressEqual(instantiated.contract as Address, plan.contract)) {
    throw new Error(`the creation emitted ${show(instantiated)}, not ${plan.contract}`);
  }
  output('faucet', plan.contract);
  console.log(`created ${plan.contract} in block ${created.block.number}`);

  const calls = [];
  for (const call of plan.calls) {
    const input = hexToBytes(call.input);
    const sim = (await api.apis.ReviveApi.call(who, plan.contract, 0n, undefined, undefined, input)) as DryRun<Returned>;
    if (!sim.result.success) throw new Error(`${call.name} fails: ${show(sim.result.value)}`);
    if (sim.result.value.flags & REVERT) throw new Error(`${call.name} reverts: ${show(sim.result.value.data)}`);
    calls.push(
      api.tx.Revive.call({
        dest: plan.contract,
        value: 0n,
        weight_limit: weightWithHalf(sim.weight_required),
        storage_deposit_limit: withHalf(charge(sim.max_storage_deposit)),
        data: input,
      }).decodedCall,
    );
  }
  const configured = await api.tx.Utility.batch_all({ calls }).createAndSubmit(signer);
  if (!configured.ok || !findEvent(configured.events as ChainEvent[], 'Utility', 'BatchCompleted')) {
    throw new Error(`the configuration failed: ${show(configured.ok ? 'no BatchCompleted event' : configured.dispatchError)}`);
  }

  const after = ((await api.query.System.Account.getValue(who)) as Balances).data;
  report([
    `### PaseoFaucet deployed at \`${plan.contract}\``,
    '',
    '| | |',
    '|---|---|',
    `| Deployer | ${who} (\`${address}\`) |`,
    `| Created | block ${created.block.number} |`,
    `| Configured | ${plan.calls.length} calls in block ${configured.block.number}: ${plan.calls.map((c) => c.name.split('(')[0]).join(', ')} |`,
    `| Spent | ${before.free - after.free} plancks in fees and storage deposits |`,
  ]);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: 'string' },
    'asset-hub': { type: 'string' },
    'mock-signer': { type: 'string' },
  },
});
const [command] = positionals;
if (!(command === 'sender' || (command === 'deploy' && values.plan))) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const mock = values['mock-signer'];
  const { signer, address } = mock ? { signer: getFakeTxCreator(mock) as Signer, address: mock } : operator();
  const client = await connect(values['asset-hub'] ? values['asset-hub'].split(',') : DEVNET.assetHub);
  try {
    if (command === 'sender') await sender(client, address);
    else await deploy(client, address, signer, values.plan!);
  } finally {
    client.destroy();
  }
  process.exit(0);
} catch (error) {
  console.error(`::error::${(error as Error).message}`);
  process.exit(1);
}
