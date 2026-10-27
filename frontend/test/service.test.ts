import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, encodeAbiParameters, encodeEventTopics, hexToBytes, type Abi, type Hex } from 'viem';
import abi from '../src/faucet.abi.json';
import { connectFaucet, type FaucetDependencies } from '../src/service';
import { PEOPLE_GENESIS } from '../src/model';

const contract = '0x1234567890123456789012345678901234567890';
const recipient = `0x${'33'.repeat(32)}` as Hex;
const context = `0x${'11'.repeat(32)}` as Hex;
const alias = `0x${'22'.repeat(32)}` as Hex;
/** A `Revive.ContractEmitted` event as papi decodes it, carrying the faucet's ABI-encoded log. */
function emitted(eventName: 'Dripped' | 'DripSkipped', destinationId: number, values: bigint[], from: Hex = contract) {
  const topics = encodeEventTopics({ abi: abi as Abi, eventName, args: { epoch: 20000n, destinationId, recipient } }) as Hex[];
  const data = eventName === 'Dripped'
    ? encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }], [2, alias, values[0], values[1]])
    : encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint8' }], [2, alias, Number(values[0])]);
  return { type: 'Revive', value: { type: 'ContractEmitted', value: { contract: from, data: hexToBytes(data), topics } } };
}
function setup(options: { heldKeys?: string[]; listDenied?: boolean; claimed?: number[]; contextMismatch?: boolean; fullNotMember?: boolean; permissionDenied?: boolean; failTx?: boolean; failDryOnce?: boolean; mapped?: boolean; pgasBalance?: bigint; productAccountError?: Error; } = {}) {
  const calls: string[] = [];
  let proofs = 0, txs = 0, drys = 0;
  let transactionArgs: unknown[] = [];
  let messageArgs: unknown[] = [];
  const ring = (lite: boolean) => ({ chainId: PEOPLE_GENESIS, junctions: [
    { tag: 'PalletInstance', value: 67 },
    { tag: 'CollectionId', value: bytesToHex(new TextEncoder().encode((lite ? 'pop:polkadot.network/people-lite' : 'pop:polkadot.network/people').padEnd(32, ' '))) },
  ] });
  class Manager {
    async connect() { return { ok: true, value: [] }; }
    async getProductAccount() {
      if (options.productAccountError) return { ok: false, error: options.productAccountError };
      return { ok: true, value: { address: 'product-account', getSigner: () => 'product-signer' } };
    }
    async listRingVrfKeys() {
      if (options.listDenied) return { ok: false, error: new Error('NotAllowlisted') };
      const keys = [{ handle: 'full', rings: [ring(false)] }, { handle: 'lite', rings: [ring(true)] }];
      return { ok: true, value: keys.filter((key) => (options.heldKeys ?? ['full', 'lite']).includes(key.handle)) };
    }
    async createRingVRFProof(handle: string, ctx: unknown, location: unknown, message: Uint8Array) {
      calls.push('proof'); ++proofs;
      assert.deepEqual(ctx, { productId: 'faucet.dot', suffix: { tag: 'Index', value: 20000 } });
      assert.deepEqual(location, ring(handle === 'lite'));
      assert.equal(bytesToHex(message), '0x1234');
      if (options.permissionDenied) return { ok: false, error: new Error('NotAllowlisted') };
      if (options.fullNotMember && handle === 'full') return { ok: false, error: new Error('NotMember') };
      return { ok: true, value: { proof: new Uint8Array(785), contextualAlias: { context: hexToBytes(options.contextMismatch ? alias : context), alias: hexToBytes(alias) }, ringIndex: 3, ringRevision: 57 } };
    }
    destroy() { calls.push('destroy-signer'); }
  }
  // Shaped as product-sdk-contracts returns them: a function's several named outputs become an object.
  const values: Record<string, unknown> = {
    productId: 'faucet.dot', DOMAIN: bytesToHex(new TextEncoder().encode('paseo-faucet:v2')),
    currentEpoch: 20000n, nextEpochStart: 1728086400n, paused: false,
    maxDripsPerEpoch: 1000, dripsInEpoch: 10,
    balances: { pas: 100000000000000n, pusd: 90000000000000n },
    destinations: [
      { id: 1000, enabled: true, pasTransfer: 1, pusdTransfer: 1, remoteFee: 0n, maxDeliveryFee: 0n, minPas: 100000000n, minPusd: 10n },
      { id: 1004, enabled: true, pasTransfer: 2, pusdTransfer: 2, remoteFee: 100000000n, maxDeliveryFee: 5000000000n, minPas: 1100000000n, minPusd: 10000n },
      { id: 1501, enabled: false, pasTransfer: 2, pusdTransfer: 0, remoteFee: 100000000n, maxDeliveryFee: 5000000000n, minPas: 1100000000n, minPusd: 0n },
    ],
    tiers: { enabled: true, pas: 250000000000n, pusd: 25000000n },
    contextFor: context, messageFor: '0x1234',
  };
  const faucet = new Proxy({}, { get: (_, method: string) => ({
    query: async (...args: unknown[]) => {
      if (method === 'drip') {
        calls.push('dry'); ++drys;
        if (options.failDryOnce && drys === 1) return { success: false, value: { reason: 'InvalidProof' } };
        return { success: true, value: null };
      }
      if (method === 'messageFor') messageArgs = args;
      if (method === 'hasClaimed') {
        assert.deepEqual([args[0], args[2]], [20000n, alias]);
        return { success: true, value: (options.claimed ?? []).includes(args[3] as number) };
      }
      return { success: true, value: values[method] };
    },
    tx: async (...args: unknown[]) => {
      ++txs; calls.push('tx'); transactionArgs = args;
      return options.failTx ? { ok: false, error: new Error('Network disconnected after submit') }
        : { ok: true, value: { txHash: `0x${'aa'.repeat(32)}`, ok: true, events: [
          { type: 'System', value: { type: 'ExtrinsicSuccess', value: {} } },
          emitted('Dripped', 1000, [250000000000n, 25000000n]),
          emitted('DripSkipped', 1004, [3n]),
          emitted('Dripped', 1004, [1n, 1n], `0x${'99'.repeat(20)}`),
        ] } };
    },
  }) });
  const dependencies = {
    isInsideContainer: () => true,
    createChainClient: async () => ({ raw: { assetHub: {} }, assetHub: { query: { Assets: { Account: { getValue: async () => ({ balance: options.pgasBalance ?? 0n }) } } } }, destroy: () => calls.push('destroy-client') }),
    SignerManager: Manager,
    createContractRuntimeFromClient: () => ({}),
    isContractAccountMapped: async () => ({ ok: true, value: options.mapped !== false }),
    ensureContractAccountMapped: async () => { calls.push('map'); return { ok: true }; },
    createContractFromClient: () => faucet,
    requestResourceAllocation: async () => { calls.push('pgas'); return { ok: true, value: ['Allocated'] }; },
  } as unknown as FaucetDependencies;
  return { dependencies, calls, get counts() { return { proofs, txs, drys }; }, get transactionArgs() { return transactionArgs; }, get messageArgs() { return messageArgs; } };
}

test('claim forwards the v2 ABI, SCALE proof and product signer, and reports what each chain got', async () => {
  const mock = setup();
  const faucet = await connectFaucet(contract, 'faucet.dot', mock.dependencies);
  const receipt = await faucet.claim(recipient, () => {});
  assert.deepEqual(mock.calls.slice(0, 4), ['pgas', 'proof', 'dry', 'tx']);
  assert.deepEqual(mock.messageArgs, [20000n, recipient]);
  const args = mock.transactionArgs;
  assert.equal(args[0], 2); assert.equal(args[1], recipient);
  assert.equal((args[2] as string).slice(0, 6), '0x450c');
  assert.equal(args[3], alias); assert.equal(args[4], 3); assert.equal(args[5], 57);
  assert.deepEqual(args[6], { signer: 'product-signer', waitFor: 'finalized' });
  assert.deepEqual(receipt, {
    txHash: `0x${'aa'.repeat(32)}`, recipient,
    paid: [{ id: 1000, pas: 250000000000n, pusd: 25000000n }],
    skipped: [{ id: 1004, reason: 'PayoutFailed' }],
  });
  faucet.destroy();
  assert.deepEqual(mock.calls.slice(-2), ['destroy-signer', 'destroy-client']);
});
test('a person paid on some chains can claim the rest; paid on every enabled chain, never reaches signing', async () => {
  const partly = setup({ claimed: [1000] });
  await (await connectFaucet(contract, 'faucet.dot', partly.dependencies)).claim(recipient, () => {});
  assert.equal(partly.counts.txs, 1);
  for (const options of [{ claimed: [1000, 1004] }, { contextMismatch: true }]) {
    const mock = setup(options);
    const faucet = await connectFaucet(contract, 'faucet.dot', mock.dependencies);
    await assert.rejects(faucet.claim(recipient, () => {}));
    assert.equal(mock.counts.txs, 0);
  }
});
test('refresh reads the views that return several values', async () => {
  const state = await (await connectFaucet(contract, 'faucet.dot', setup().dependencies)).refresh();
  assert.deepEqual([state.pasBalance, state.pusdBalance], [100000000000000n, 90000000000000n]);
  assert.deepEqual([state.lite, state.full], [{ enabled: true, pas: 250000000000n, pusd: 25000000n }, { enabled: true, pas: 250000000000n, pusd: 25000000n }]);
});
test('a host nobody is signed in to asks for a sign-in; other refusals pass through', async () => {
  const hostError = (tag: string) => new Error(`Host rejected product account request: Domain → V1 → ${tag}`, { cause: { tag: 'Domain', value: { tag: 'V1', value: { tag } } } });
  await assert.rejects(connectFaucet(contract, 'faucet.dot', setup({ productAccountError: hostError('NotConnected') }).dependencies),
    /^Error: Sign in to this Polkadot host with your Polkadot app, then connect again\.$/);
  await assert.rejects(connectFaucet(contract, 'faucet.dot', setup({ productAccountError: hostError('DomainNotValid') }).dependencies),
    /Domain → V1 → DomainNotValid/);
});
test('connect reports the personhood tiers the person holds a key for', async () => {
  const cases: [Parameters<typeof setup>[0], number[]][] = [[{}, [2, 1]], [{ heldKeys: ['lite'] }, [1]], [{ listDenied: true }, []]];
  for (const [options, expected] of cases) {
    const faucet = await connectFaucet(contract, 'faucet.dot', setup(options).dependencies);
    assert.deepEqual(faucet.heldTiers, expected);
  }
});
test('new product accounts allocate fees before account mapping', async () => {
  const mock = setup({ mapped: false });
  await connectFaucet(contract, 'faucet.dot', mock.dependencies);
  assert.deepEqual(mock.calls, ['pgas', 'map']);
});
test('accounts with enough PGAS do not consume another host allocation', async () => {
  const mock = setup({ pgasBalance: 30_000_000_000n });
  await (await connectFaucet(contract, 'faucet.dot', mock.dependencies)).claim(recipient, () => {});
  assert.deepEqual(mock.calls, ['proof', 'dry', 'tx']);
});
test('NotMember permits a lite fallback, while host permission failures stop immediately', async () => {
  const lite = setup({ fullNotMember: true });
  const fallback = await connectFaucet(contract, 'faucet.dot', lite.dependencies);
  assert.deepEqual(fallback.heldTiers, [2, 1]);
  await fallback.claim(recipient, () => {});
  assert.equal(lite.transactionArgs[0], 1);
  assert.deepEqual(fallback.heldTiers, [1]);
  const denied = setup({ permissionDenied: true });
  const faucet = await connectFaucet(contract, 'faucet.dot', denied.dependencies);
  await assert.rejects(faucet.claim(recipient, () => {}), /NotAllowlisted/);
  assert.deepEqual(denied.counts, { proofs: 1, txs: 0, drys: 0 });
});
test('an invalid preflight proof is regenerated once before signing', async () => {
  const mock = setup({ failDryOnce: true });
  await (await connectFaucet(contract, 'faucet.dot', mock.dependencies)).claim(recipient, () => {});
  assert.deepEqual(mock.counts, { proofs: 2, drys: 2, txs: 1 });
});
test('uncertain transaction failure never triggers automatic resubmission', async () => {
  const mock = setup({ failTx: true });
  const faucet = await connectFaucet(contract, 'faucet.dot', mock.dependencies);
  await assert.rejects(faucet.claim(recipient, () => {}), /Network disconnected/);
  assert.equal(mock.counts.txs, 1);
});
