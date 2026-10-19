import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { AccountId, decAnyMetadata, unifyMetadata, type UnifiedMetadata } from '@polkadot-api/substrate-bindings';
import type { PolkadotClient, Transaction } from 'polkadot-api';
import { getFakeTxCreator } from 'polkadot-api/tx-creator';
import { createWsClient } from 'polkadot-api/ws';
import {
  type Abi,
  type Hex,
  bytesToHex,
  decodeErrorResult,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  hexToBytes,
} from 'viem';

/** Chain name to its chopsticks config in `chopsticks/`. */
export const CHAINS = {
  assetHub: 'asset-hub',
  people: 'people',
} as const;
export type ChainName = keyof typeof CHAINS;

export const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
export const PUSD_ASSET_ID = 50000413;
/** pUSD on People ("Digital Dollar"): a local asset keyed by its Asset Hub location. */
export const PUSD_ON_PEOPLE = {
  parents: 1,
  interior: {
    type: 'X3',
    value: [
      { type: 'Parachain', value: 1000 },
      { type: 'PalletInstance', value: 50 },
      { type: 'GeneralIndex', value: BigInt(PUSD_ASSET_ID) },
    ],
  },
};
export const WEI_PER_PLANCK = 10n ** 8n;
const REVERT_FLAG = 1;

export interface Chain {
  name: ChainName;
  paraId: number;
  specName: string;
  specVersion: number;
  /** Head when the network started. */
  forkedAt: number;
  /** The live endpoints the fork reads its state from. */
  source: Record<string, unknown>;
  client: PolkadotClient;
  /** papi's untyped API (the forks run whatever runtime is live); use it to build transactions. */
  api: any;
  metadata: UnifiedMetadata;
  codecs: ReturnType<typeof getDynamicBuilder>;
}

export interface Network {
  chains: Record<ChainName, Chain>;
  close(): Promise<void>;
}

export interface ChainEvent {
  block: number;
  /** Index of the extrinsic that emitted it, if any. */
  extrinsic?: number;
  pallet: string;
  name: string;
  value: any;
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  /** The solc version that built it. */
  compiler: string;
}

export interface Revert {
  errorName: string;
  args: readonly unknown[];
}

export interface CallOptions {
  allowRevert?: boolean;
}

export interface Weight {
  ref_time: bigint;
  proof_size: bigint;
}

export interface CallResult {
  ok: boolean;
  revert?: Revert;
  weight: Weight;
  deposit: bigint;
  events: ChainEvent[];
}

/**
 * Starts chopsticks forks of every chain in `CHAINS` with their HRMP channels connected (xcm mode) and connects
 * to them. Blocks are built only on demand: by `send` (one block per extrinsic) and `untilEvent`. `close()` stops
 * everything.
 */
export async function startNetwork(): Promise<Network> {
  const names = Object.keys(CHAINS) as ChainName[];
  process.env.LOG_LEVEL ??= 'warn';
  // chopsticks reads LOG_LEVEL when it loads.
  const { BuildBlockMode, connectParachains, destroyWorker, fetchConfig, setupWithServer } = await import(
    '@acala-network/chopsticks'
  );
  const cache = fileURLToPath(new URL('.cache/', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const servers: Awaited<ReturnType<typeof setupWithServer>>[] = [];
  const sources: Chain['source'][] = [];
  const chains = {} as Record<ChainName, Chain>;
  const close = async () => {
    Object.values<Chain>(chains).forEach((c) => c.client.destroy());
    await Promise.all(servers.map((s) => s.close()));
    await destroyWorker();
  };
  try {
    for (const name of names) {
      const config = await fetchConfig(fileURLToPath(new URL(`chopsticks/${CHAINS[name]}.yml`, import.meta.url)));
      const server = await setupWithServer({
        ...config,
        'build-block-mode': BuildBlockMode.Manual,
        db: `${cache}${name}.sqlite`,
      });
      servers.push(server);
      sources.push({ endpoints: config.endpoint });
    }
    await connectParachains(servers.map((s) => s.chain));
    for (const [i, name] of names.entries()) {
      // chopsticks moves to the next free port when the configured one is taken
      chains[name] = await connect(name, Number(servers[i]!.addr.split(':').pop()), sources[i]!);
    }
    return { chains, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Connects to any node, a fork or a live chain, for `query`, `runtimeCall`, `constant` and `head`. */
export async function open(url: string) {
  // A fork is silent between blocks and can spend minutes on one fetching remote state: never treat it as stale.
  const client = createWsClient(url, { heartbeatTimeout: 2 ** 31 - 1 });
  const best = (await client.getBestBlocks())[0]!;
  const metadata = unifyMetadata(decAnyMetadata(await client.getMetadata(best.hash)));
  return { client, metadata, codecs: getDynamicBuilder(getLookupFn(metadata)) };
}

async function connect(name: ChainName, port: number, source: Chain['source']): Promise<Chain> {
  const connected = await open(`ws://127.0.0.1:${port}`);
  const chain = { ...connected, name, source, api: connected.client.getUnsafeApi() };
  const version = constant(chain, 'System', 'Version');
  return {
    ...chain,
    forkedAt: await head(chain),
    paraId: await query(chain, 'ParachainInfo', 'ParachainId'),
    specName: version.spec_name,
    specVersion: version.spec_version,
  };
}

type Connected = Pick<Chain, 'client' | 'metadata' | 'codecs'>;

export function constant(chain: Connected, pallet: string, name: string): any {
  const entry = chain.metadata.pallets.find((p) => p.name === pallet)?.constants.find((c) => c.name === name);
  if (!entry) throw new Error(`no constant ${pallet}.${name}`);
  return chain.codecs.buildConstant(pallet, name).dec(entry.value);
}

/** Reads a storage entry at the current head. */
export async function query(chain: Connected, pallet: string, item: string, ...keys: unknown[]): Promise<any> {
  const storage = chain.codecs.buildStorage(pallet, item);
  const raw = await chain.client._request<Hex | null, [string]>('state_getStorage', [storage.keys.enc(...keys)]);
  return raw === null ? storage.fallback : storage.value.dec(raw);
}

/** Calls a runtime API at the current head. */
export async function runtimeCall(chain: Connected, api: string, method: string, ...args: unknown[]): Promise<any> {
  const codec = chain.codecs.buildRuntimeCall(api, method);
  const raw = await chain.client._request<Hex, [string, Hex]>('state_call', [
    `${api}_${method}`,
    bytesToHex(codec.args.enc(args)),
  ]);
  return codec.value.dec(raw);
}

export async function head(chain: Connected): Promise<number> {
  return Number((await chain.client._request<{ number: Hex }, []>('chain_getHeader', [])).number);
}

const newBlock = (chain: Chain) => chain.client._request<Hex, [{ count: number }]>('dev_newBlock', [{ count: 1 }]);

const blockHash = (chain: Chain, block: number) => chain.client._request<Hex, [number]>('chain_getBlockHash', [block]);

async function blockEvents(chain: Chain, block: number): Promise<ChainEvent[]> {
  const storage = chain.codecs.buildStorage('System', 'Events');
  const raw = await chain.client._request<Hex | null, [string, Hex]>('state_getStorage', [
    storage.keys.enc(),
    await blockHash(chain, block),
  ]);
  return (raw ? storage.value.dec(raw) : []).map(({ phase, event }: any) => ({
    block,
    extrinsic: phase.type === 'ApplyExtrinsic' ? phase.value : undefined,
    pallet: event.type,
    name: event.value.type,
    value: event.value.value,
  }));
}

/** Events of every block after `fromBlock` up to the current head. */
export async function eventsSince(chain: Chain, fromBlock: number): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  for (let block = fromBlock + 1, last = await head(chain); block <= last; block++) {
    out.push(...(await blockEvents(chain, block)));
  }
  return out;
}

/** Builds blocks one by one until an event after `fromBlock` matches; returns every event since `fromBlock`. */
export async function untilEvent(
  chain: Chain,
  fromBlock: number,
  match: (e: ChainEvent) => boolean,
  maxBlocks = 5,
): Promise<ChainEvent[]> {
  for (let built = 0; ; built++) {
    const events = await eventsSince(chain, fromBlock);
    if (events.some(match)) return events;
    if (built === maxBlocks) {
      throw new Error(`${chain.name}: no matching event in ${maxBlocks} blocks after #${fromBlock}`);
    }
    await newBlock(chain);
  }
}

export const trappedAssets = (events: ChainEvent[]) =>
  events.filter((e) => e.pallet === 'PolkadotXcm' && e.name === 'AssetsTrapped');

export const ss58 = (accountId: Hex) => AccountId(42).dec(hexToBytes(accountId));
export const accountHex = (address: string) => bytesToHex(AccountId().enc(address));
/** The AccountId32 of a contract, or of any Ethereum-derived account, on Asset Hub. */
export const contractAccount = (address: Hex) => ss58(`${address}${'ee'.repeat(12)}`);

/** Accepts an SS58 address or a 32-byte hex account id. */
const asSs58 = (who: string) => (who.startsWith('0x') ? ss58(who as Hex) : who);

export async function pas(chain: Chain, who: string): Promise<bigint> {
  return (await query(chain, 'System', 'Account', asSs58(who))).data.free;
}

export async function pusd(chain: Chain, who: string): Promise<bigint> {
  const asset = chain.name === 'assetHub' ? PUSD_ASSET_ID : PUSD_ON_PEOPLE;
  return (await query(chain, 'Assets', 'Account', asset, asSs58(who)))?.balance ?? 0n;
}

/**
 * Signs `tx` as Alice with a fake signature (the forks run with `mock-signature-host`), validates it, builds a
 * block with it and returns the extrinsic's outcome and events. An invalid transaction throws.
 */
export async function send(chain: Chain, tx: Transaction<any>) {
  const nonce = await chain.client._request<number, [string]>('system_accountNextIndex', [ALICE]);
  const extrinsic = bytesToHex(await tx.create(getFakeTxCreator(ALICE), { nonce, mortality: { mortal: false } }));
  const parent = await head(chain);
  const validity = chain.codecs
    .buildRuntimeCall('TaggedTransactionQueue', 'validate_transaction')
    .value.dec(
      await chain.client._request<Hex, [string, Hex]>('state_call', [
        'TaggedTransactionQueue_validate_transaction',
        `0x02${extrinsic.slice(2)}${(await blockHash(chain, parent)).slice(2)}`,
      ]),
    );
  if (!validity.success) throw new Error(`${chain.name}: invalid transaction: ${json(validity.value)}`);
  // Handing the extrinsic to the block builder skips the pool, which cannot decode every Asset Hub extrinsic.
  await chain.client._request<Hex, [{ transactions: Hex[] }]>('dev_newBlock', [{ transactions: [extrinsic] }]);
  // chopsticks may append blocks to process queued messages, so look in the first new one.
  const { block } = await chain.client._request<{ block: { extrinsics: Hex[] } }, [Hex]>('chain_getBlock', [
    await blockHash(chain, parent + 1),
  ]);
  const index = block.extrinsics.indexOf(extrinsic);
  if (index < 0) throw new Error(`${chain.name}: extrinsic missing from block #${parent + 1}`);
  const events = (await blockEvents(chain, parent + 1)).filter((e) => e.extrinsic === index);
  const failed = events.find((e) => e.pallet === 'System' && e.name === 'ExtrinsicFailed');
  return { ok: !failed, dispatchError: failed?.value.dispatch_error, events };
}

/** Like `send`, but throws when the extrinsic fails. */
export async function submit(chain: Chain, tx: Transaction<any>): Promise<ChainEvent[]> {
  const result = await send(chain, tx);
  if (!result.ok) throw new Error(`${chain.name}: extrinsic failed: ${json(result.dispatchError)}`);
  return result.events;
}

export const transferPas = (chain: Chain, to: string, amount: bigint) =>
  submit(chain, chain.api.tx.Balances.transfer_keep_alive({ dest: { type: 'Id', value: asSs58(to) }, value: amount }));

export const transferPusd = (ah: Chain, to: string, amount: bigint) =>
  submit(ah, ah.api.tx.Assets.transfer({ id: PUSD_ASSET_ID, target: { type: 'Id', value: asSs58(to) }, amount }));

export const h160 = (ah: Chain, who: string): Promise<Hex> => runtimeCall(ah, 'ReviveApi', 'address', asSs58(who));

export function loadArtifact(path: string): Artifact {
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: artifact.abi, bytecode: artifact.bytecode.object, compiler: artifact.metadata.compiler.version };
}

const charge = (deposit: { type: string; value: bigint }) => (deposit.type === 'Charge' ? deposit.value : 0n);

function decodeRevert(abi: Abi, data: Uint8Array): Revert {
  try {
    const { errorName, args } = decodeErrorResult({ abi, data: bytesToHex(data) });
    return { errorName, args: args ?? [] };
  } catch {
    return { errorName: 'Unknown', args: [bytesToHex(data)] };
  }
}

/** Deploys EVM bytecode with `Revive.instantiate_with_code`, using a `ReviveApi` dry run's limits. */
export async function deploy(
  ah: Chain,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<{ address: Hex; events: ChainEvent[] }> {
  const code = hexToBytes(encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
  const data = new Uint8Array();
  // A fresh CREATE2 salt, because a forked account's nonce may point at a contract it already deployed.
  const salt = bytesToHex(randomBytes(32));
  const upload = { type: 'Upload', value: code };
  const value = 0n;
  const noLimit = undefined;
  const dry = await runtimeCall(ah, 'ReviveApi', 'instantiate', ALICE, value, noLimit, noLimit, upload, data, salt);
  if (!dry.result.success) throw new Error(`instantiate dry run failed: ${json(dry.result.value)}`);
  if (dry.result.value.result.flags & REVERT_FLAG) {
    throw new Error(`constructor reverted: ${json(decodeRevert(artifact.abi, dry.result.value.result.data))}`);
  }
  const tx = ah.api.tx.Revive.instantiate_with_code({
    value,
    weight_limit: dry.weight_required,
    storage_deposit_limit: charge(dry.max_storage_deposit),
    code,
    data,
    salt,
  });
  const events = await submit(ah, tx);
  const instantiated = events.find((e) => e.pallet === 'Revive' && e.name === 'Instantiated');
  if (!instantiated) throw new Error('no Revive.Instantiated event');
  return { address: instantiated.value.contract, events };
}

/** Dry-runs a contract call through `ReviveApi.call`; a revert throws unless `allowRevert`. */
export async function simulate(
  ah: Chain,
  address: Hex,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  { allowRevert = false }: CallOptions = {},
) {
  const input = hexToBytes(encodeFunctionData({ abi, functionName, args }));
  const noLimit = undefined;
  const dry = await runtimeCall(ah, 'ReviveApi', 'call', ALICE, address, 0n, noLimit, noLimit, input);
  if (!dry.result.success) throw new Error(`${functionName} dry run failed: ${json(dry.result.value)}`);
  const { flags, data } = dry.result.value;
  const revert = flags & REVERT_FLAG ? decodeRevert(abi, data) : undefined;
  if (revert && !allowRevert) throw new Error(`${functionName} reverted: ${json(revert)}`);
  return {
    input,
    revert,
    result: revert ? undefined : decodeFunctionResult({ abi, functionName, data: bytesToHex(data) }),
    weight: dry.weight_required as Weight,
    deposit: charge(dry.max_storage_deposit),
  };
}

/** Reads a view function. */
export async function read(ah: Chain, address: Hex, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  return (await simulate(ah, address, abi, functionName, args)).result;
}

/**
 * Calls a contract with a Substrate-signed `Revive.call` whose limits come from the dry run. With
 * `allowRevert`, a reverting call is still submitted and reported with `ok: false`.
 */
export async function call(
  ah: Chain,
  address: Hex,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  options: CallOptions = {},
): Promise<CallResult> {
  const sim = await simulate(ah, address, abi, functionName, args, options);
  const tx = ah.api.tx.Revive.call({
    dest: address,
    value: 0n,
    weight_limit: sim.weight,
    storage_deposit_limit: sim.deposit,
    data: sim.input,
  });
  const { ok, dispatchError, events } = await send(ah, tx);
  if (!ok && !sim.revert) throw new Error(`${functionName} failed: ${json(dispatchError)}`);
  const { revert, weight, deposit } = sim;
  return { ok, revert, weight, deposit, events };
}

/** The runtime's own `VersionedXcm` codec: `PolkadotXcm.execute`'s `message` type, which the XCM precompile decodes. */
export function xcmCodec(chain: Chain) {
  const calls = chain.metadata.pallets.find((p) => p.name === 'PolkadotXcm')?.calls;
  if (!calls) throw new Error(`${chain.name} has no PolkadotXcm calls`);
  const entry = getLookupFn(chain.metadata)(calls.type);
  if (entry.type !== 'enum' || entry.value.execute?.type !== 'struct') {
    throw new Error(`${chain.name}: unexpected PolkadotXcm.execute shape`);
  }
  return chain.codecs.buildDefinition(entry.value.execute.value.message.id);
}

export const decodeXcm = (chain: Chain, message: Hex | Uint8Array) =>
  toJson(xcmCodec(chain).dec(typeof message === 'string' ? hexToBytes(message) : message));

/** Plain JSON view of a decoded value: bigints as decimal strings, bytes as hex. */
export const toJson = (value: unknown): any => JSON.parse(json(value));

export function json(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v,
  );
}
