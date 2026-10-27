import { CarReader, CarWriter } from '@ipld/car';
import * as dagPB from '@ipld/dag-pb';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { createPublicClient, hexToBytes, http, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';
import { namehash } from 'viem/ens';

export interface Block {
  cid: CID;
  bytes: Uint8Array;
}

/** The CID in an `ipfs-ns` contenthash, `0xe301` followed by the CID's bytes, as DotNS stores it. */
export function decodeContenthash(contenthash: Hex): CID {
  const bytes = hexToBytes(contenthash);
  if (bytes[0] !== 0xe3 || bytes[1] !== 0x01) throw new Error(`not an IPFS contenthash: ${contenthash}`);
  return CID.decode(bytes.subarray(2));
}

const registryAbi = [
  { type: 'function', name: 'resolver', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const;
const resolverAbi = [
  { type: 'function', name: 'contenthash', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'bytes' }] },
] as const;

/** The root CID a DotNS name points at, read from the name's resolver. */
export async function resolveRoot(name: string, ethRpc: string, registry: Address): Promise<CID> {
  const client = createPublicClient({ transport: http(ethRpc) });
  const node = namehash(name);
  const resolver = await client.readContract({ address: registry, abi: registryAbi, functionName: 'resolver', args: [node] });
  if (isAddressEqual(resolver, zeroAddress)) throw new Error(`${name} has no resolver`);
  const contenthash = await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'contenthash', args: [node] });
  if (contenthash === '0x') throw new Error(`${name} points at no content`);
  return decodeContenthash(contenthash);
}

/** Throws unless `bytes` hash to `cid`. Bulletin holds the app as raw and dag-pb blocks under SHA-256. */
export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.code !== raw.code && cid.code !== dagPB.code) throw new Error(`${cid}: unsupported codec 0x${cid.code.toString(16)}`);
  if (cid.multihash.code !== sha256.code) throw new Error(`${cid}: unsupported hash 0x${cid.multihash.code.toString(16)}`);
  const digest = await sha256.digest(bytes);
  if (Buffer.compare(digest.digest, cid.multihash.digest) !== 0) throw new Error(`${cid}: the bytes do not match the CID`);
}

/** Every block reachable from `root` through dag-pb links, root first, each fetched once and verified. */
export async function walk(root: CID, fetchBlock: (cid: CID) => Promise<Uint8Array>): Promise<Block[]> {
  const blocks: Block[] = [];
  const seen = new Set<string>();
  const visit = async (cid: CID): Promise<void> => {
    if (seen.has(cid.toString())) return;
    seen.add(cid.toString());
    const bytes = await fetchBlock(cid);
    await verifyBlock(cid, bytes);
    blocks.push({ cid, bytes });
    if (cid.code === dagPB.code) for (const link of dagPB.decode(bytes).Links) await visit(link.Hash);
  };
  await visit(root);
  return blocks;
}

/** Fetches raw blocks from a trustless IPFS gateway, five attempts with growing delays. */
export function gatewayFetcher(gateway: string): (cid: CID) => Promise<Uint8Array> {
  return async (cid) => {
    let failure = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(`${gateway}/ipfs/${cid}?format=raw`, { headers: { accept: 'application/vnd.ipld.raw' } });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        failure = `HTTP ${res.status}`;
      } catch (error) {
        failure = (error as Error).message;
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    }
    throw new Error(`${cid}: the gateway failed: ${failure}`);
  };
}

/** A CAR with `root` as its only root and `blocks` in order. */
export async function encodeCar(root: CID, blocks: Block[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const parts: Uint8Array[] = [];
  const collected = (async () => {
    for await (const part of out) parts.push(part);
  })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await collected;
  return Buffer.concat(parts);
}

/** The root and the verified blocks of an archive written by `encodeCar`. */
export async function decodeCar(bytes: Uint8Array): Promise<{ root: CID; blocks: Block[] }> {
  const reader = await CarReader.fromBytes(bytes);
  const roots = await reader.getRoots();
  if (roots.length !== 1) throw new Error(`expected one root, found ${roots.length}`);
  const [root] = roots;
  const blocks: Block[] = [];
  for await (const block of reader.blocks()) {
    await verifyBlock(block.cid, block.bytes);
    blocks.push(block);
  }
  if (!blocks.some((block) => block.cid.equals(root))) throw new Error(`the archive lacks its root ${root}`);
  return { root, blocks };
}

export interface Plan {
  /** Whether the blocks should be stored again now. */
  due: boolean;
  /** Blocks Bulletin no longer holds. */
  missing: number;
  /** The block the oldest held block was stored at. */
  oldestStoredAt?: number;
  /** Blocks until the oldest held block expires. */
  blocksLeft?: number;
}

/**
 * What keeps an account able to store for `minBlocks` more: a new grant when it has none or it has
 * expired, an extension when it ends sooner, nothing otherwise. `expiration` is the block its grant ends at.
 */
export function authorizationUpkeep(expiration: number | undefined, head: number, minBlocks: number): 'grant' | 'extend' | 'none' {
  if (expiration === undefined || expiration <= head) return 'grant';
  return expiration - head < minBlocks ? 'extend' : 'none';
}

/**
 * Whether a keep-alive pass is due: when a block is missing, or when the oldest store is at least
 * `minAgeBlocks` old. `storedAt` holds the block each archived block was last stored at, if Bulletin holds it.
 */
export function plan(storedAt: (number | undefined)[], head: number, retention: number, minAgeBlocks: number): Plan {
  const held = storedAt.filter((block): block is number => block !== undefined);
  const missing = storedAt.length - held.length;
  if (held.length === 0) return { due: true, missing };
  const oldestStoredAt = Math.min(...held);
  return {
    due: missing > 0 || head - oldestStoredAt >= minAgeBlocks,
    missing,
    oldestStoredAt,
    blocksLeft: oldestStoredAt + retention - head,
  };
}

interface ForgeTransaction {
  transactionType: string;
  function: string | null;
  contractAddress: string | null;
  transaction: { from: string; to: string | null; input: string; nonce: string; value?: string };
}

export interface DeployPlan {
  /** The account forge simulated as, and the contract's address and creation nonce. */
  sender: Address;
  nonce: number;
  contract: Address;
  /** The creation code with the constructor arguments appended. */
  initcode: Hex;
  calls: { name: string; input: Hex }[];
}

/**
 * The transactions of a `forge script` run, checked to create one contract and then only call it,
 * all from one sender and without value.
 */
export function parsePlan(run: { transactions: ForgeTransaction[] }): DeployPlan {
  const [create, ...calls] = run.transactions;
  if (create?.transactionType !== 'CREATE' || !create.contractAddress) throw new Error('the plan does not start with a contract creation');
  const contract = create.contractAddress as Address;
  const sender = create.transaction.from as Address;
  for (const t of run.transactions) {
    const name = t.function ?? t.transactionType;
    if (!isAddressEqual(t.transaction.from as Address, sender)) throw new Error(`${name} is sent by ${t.transaction.from}, not ${sender}`);
    if (BigInt(t.transaction.value ?? '0x0') !== 0n) throw new Error(`${name} sends value`);
    if (t !== create && (t.transactionType !== 'CALL' || !t.transaction.to || !isAddressEqual(t.transaction.to as Address, contract))) {
      throw new Error(`${name} is not a call to ${contract}`);
    }
  }
  return {
    sender,
    nonce: Number(create.transaction.nonce),
    contract,
    initcode: create.transaction.input as Hex,
    calls: calls.map((t) => ({ name: t.function ?? 'call', input: t.transaction.input as Hex })),
  };
}

export interface CallPlan {
  /** The account forge simulated as, and its nonce at the first call. */
  sender: Address;
  nonce: number;
  calls: { name: string; input: Hex }[];
}

/** The transactions of a `forge script` run, checked to only call `contract`, all from one sender and without value. */
export function parseCalls(run: { transactions: ForgeTransaction[] }, contract: Address): CallPlan {
  const [first] = run.transactions;
  if (!first) throw new Error('the plan has no calls');
  const sender = first.transaction.from as Address;
  for (const t of run.transactions) {
    const name = t.function ?? t.transactionType;
    if (t.transactionType !== 'CALL' || !t.transaction.to || !isAddressEqual(t.transaction.to as Address, contract)) {
      throw new Error(`${name} is not a call to ${contract}`);
    }
    if (!isAddressEqual(t.transaction.from as Address, sender)) throw new Error(`${name} is sent by ${t.transaction.from}, not ${sender}`);
    if (BigInt(t.transaction.value ?? '0x0') !== 0n) throw new Error(`${name} sends value`);
  }
  return {
    sender,
    nonce: Number(first.transaction.nonce),
    calls: run.transactions.map((t) => ({ name: t.function ?? 'call', input: t.transaction.input as Hex })),
  };
}
