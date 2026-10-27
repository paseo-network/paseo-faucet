import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as dagPB from '@ipld/dag-pb';
import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { signerFromMnemonic, signerFromUri } from '../keys.ts';
import { authorizationUpkeep, decodeCar, decodeContenthash, encodeCar, parsePlan, plan, verifyBlock, walk, type Block } from '../lib.ts';

async function rawBlock(text: string): Promise<Block> {
  const bytes = new TextEncoder().encode(text);
  return { cid: CID.createV1(raw.code, await sha256.digest(bytes)), bytes };
}

async function dagBlock(links: Block[]): Promise<Block> {
  const bytes = dagPB.encode(dagPB.prepare({ Links: links.map((link) => ({ Hash: link.cid, Tsize: link.bytes.length })) }));
  return { cid: CID.createV1(dagPB.code, await sha256.digest(bytes)), bytes };
}

const fetcherOf = (blocks: Block[], calls: string[] = []) => async (cid: CID) => {
  calls.push(cid.toString());
  const found = blocks.find((block) => block.cid.equals(cid));
  if (!found) throw new Error(`no block ${cid}`);
  return found.bytes;
};

test('decodes the contenthash DotNS stores', () => {
  const cid = decodeContenthash('0xe3010170122046ab149347ccb1382be4c24a7b71607ed9e550c5936cbed435f49f99cce2402e');
  assert.equal(cid.toString(), 'bafybeicgvmkjgr6mwe4cxzgcjj5xcyd63hsvbrmtns7ninput6m4zysafy');
  assert.throws(() => decodeContenthash('0xe5010170'), /not an IPFS contenthash/);
});

test('verifies a block against its CID, codec and hash', async () => {
  const block = await rawBlock('chunk');
  await verifyBlock(block.cid, block.bytes);
  await assert.rejects(verifyBlock(block.cid, new TextEncoder().encode('other')), /do not match/);
  const cbor = CID.createV1(0x71, block.cid.multihash);
  await assert.rejects(verifyBlock(cbor, block.bytes), /unsupported codec/);
});

test('walks every block from the root once, root first', async () => {
  const [a, b] = await Promise.all([rawBlock('a'), rawBlock('b')]);
  const inner = await dagBlock([b]);
  const root = await dagBlock([a, inner, a]);
  const calls: string[] = [];
  const blocks = await walk(root.cid, fetcherOf([root, inner, a, b], calls));
  assert.deepEqual(blocks.map((block) => block.cid.toString()), [root, a, inner, b].map((block) => block.cid.toString()));
  assert.equal(new Set(calls).size, calls.length);
});

test('a walk fails on a block that does not match its CID', async () => {
  const a = await rawBlock('a');
  const root = await dagBlock([a]);
  await assert.rejects(walk(root.cid, fetcherOf([root, { cid: a.cid, bytes: new TextEncoder().encode('tampered') }])), /do not match/);
});

test('an archive round-trips and is verified when read', async () => {
  const a = await rawBlock('a');
  const root = await dagBlock([a]);
  const decoded = await decodeCar(await encodeCar(root.cid, [root, a]));
  assert.ok(decoded.root.equals(root.cid));
  assert.deepEqual(decoded.blocks.map((block) => block.cid.toString()), [root.cid.toString(), a.cid.toString()]);

  await assert.rejects(decodeCar(await encodeCar(root.cid, [a])), /lacks its root/);
  const tampered = await encodeCar(root.cid, [root, a]);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(decodeCar(tampered), /do not match/);
});

test('an archive has exactly one root', async () => {
  const [a, b] = await Promise.all([rawBlock('a'), rawBlock('b')]);
  const { writer, out } = CarWriter.create([a.cid, b.cid]);
  const parts: Uint8Array[] = [];
  const collected = (async () => {
    for await (const part of out) parts.push(part);
  })();
  await writer.put(a);
  await writer.put(b);
  await writer.close();
  await collected;
  await assert.rejects(decodeCar(Buffer.concat(parts)), /expected one root/);
});

test('a pass is due when a block is missing or the oldest store is old enough', () => {
  const retention = 201_600;
  assert.deepEqual(plan([1_000, 2_000], 100_000, retention, 187_200), {
    due: false,
    missing: 0,
    oldestStoredAt: 1_000,
    blocksLeft: 102_600,
  });
  assert.equal(plan([1_000, 2_000], 188_200, retention, 187_200).due, true);
  assert.equal(plan([1_000, 2_000], 188_199, retention, 187_200).due, false);
  assert.deepEqual(plan([1_000, undefined], 1_500, retention, 187_200), {
    due: true,
    missing: 1,
    oldestStoredAt: 1_000,
    blocksLeft: 201_100,
  });
  assert.deepEqual(plan([undefined, undefined], 1_500, retention, 187_200), { due: true, missing: 2 });
});

test('an authorization is granted when absent or expired, extended when it ends too soon', () => {
  assert.equal(authorizationUpkeep(undefined, 1_000, 43_200), 'grant');
  assert.equal(authorizationUpkeep(1_000, 1_000, 43_200), 'grant');
  assert.equal(authorizationUpkeep(44_199, 1_000, 43_200), 'extend');
  assert.equal(authorizationUpkeep(44_200, 1_000, 43_200), 'none');
});

test('the signer is the root sr25519 account of the mnemonic', () => {
  const { address } = signerFromMnemonic('bottom drive obey lake curtain smoke basket hold race lonely fit walk');
  assert.equal(address, '5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV');
});

test('a key URI derives its path, from the development phrase when it starts with one', () => {
  const eve = '5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw';
  assert.equal(signerFromUri('//Eve').address, eve);
  assert.equal(signerFromUri('bottom drive obey lake curtain smoke basket hold race lonely fit walk//Eve').address, eve);
  assert.equal(signerFromUri('bottom drive obey lake curtain smoke basket hold race lonely fit walk').address, '5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV');
  assert.throws(() => signerFromUri('not a uri//Eve'));
});

test('a deploy plan creates one contract, then only calls it, from one sender without value', () => {
  const sender = '0x69c6813b5fa6bb299c70e4eb61e94eb17f51c6e1';
  const contract = '0x0d84e053e5ac065c4caa3c5dc67eb1f63b93e533';
  const create = { transactionType: 'CREATE', function: null, contractAddress: contract, transaction: { from: sender, to: null, input: '0x60a0', nonce: '0x0', value: '0x0' } } as const;
  const call = (to: string, extra = {}) => ({ transactionType: 'CALL', function: 'setPauser(address)', contractAddress: to, transaction: { from: sender, to, input: '0x1234', nonce: '0x1', value: '0x0', ...extra } });
  assert.deepEqual(parsePlan({ transactions: [create, call(contract)] }), {
    sender,
    nonce: 0,
    contract,
    initcode: '0x60a0',
    calls: [{ name: 'setPauser(address)', input: '0x1234' }],
  });
  assert.throws(() => parsePlan({ transactions: [call(contract)] }), /does not start with a contract creation/);
  assert.throws(() => parsePlan({ transactions: [create, call('0x0000000000000000000000000000000000000001')] }), /is not a call to/);
  assert.throws(() => parsePlan({ transactions: [create, { ...create }] }), /is not a call to/);
  assert.throws(() => parsePlan({ transactions: [create, call(contract, { from: contract })] }), /is sent by/);
  assert.throws(() => parsePlan({ transactions: [create, call(contract, { value: '0x1' })] }), /sends value/);
});
