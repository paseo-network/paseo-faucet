import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, encodeAbiParameters, encodeEventTopics, hexToBytes, type Abi, type Hex } from 'viem';
import abi from '../src/faucet.abi.json';
import { openFaucet, type FaucetDependencies } from '../src/service';
import { PEOPLE_GENESIS, type FaucetHost } from '../src/model';

const contract = '0x1234567890123456789012345678901234567890';
const recipient = `0x${'33'.repeat(32)}` as Hex;
const context = `0x${'11'.repeat(32)}` as Hex;
const alias = `0x${'22'.repeat(32)}` as Hex;
/** A host refusal as the signer returns it: the message, and the host's own tagged error as the cause. */
const hostError = (tag: string) => new Error(`Host rejected the request: Domain → V1 → ${tag}`, { cause: { tag: 'Domain', value: { tag: 'V1', value: { tag } } } });
/** A `Revive.ContractEmitted` event as papi decodes it, carrying the faucet's ABI-encoded log. */
function emitted(eventName: 'Dripped' | 'DripSkipped', destinationId: number, values: bigint[], from: Hex = contract) {
  const topics = encodeEventTopics({ abi: abi as Abi, eventName, args: { epoch: 20000n, destinationId, recipient } }) as Hex[];
  const data = eventName === 'Dripped'
    ? encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint128' }, { type: 'uint128' }], [2, alias, values[0], values[1]])
    : encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint8' }], [2, alias, Number(values[0])]);
  return { type: 'Revive', value: { type: 'ContractEmitted', value: { contract: from, data: hexToBytes(data), topics } } };
}
function setup(options: { heldKeys?: string[]; listDenied?: boolean; claimed?: number[]; contextMismatch?: boolean; fullNotMember?: boolean; permissionDenied?: boolean; failTx?: boolean; failDryOnce?: boolean; mapped?: boolean; pgasBalance?: bigint; productAccountError?: Error; outside?: boolean; login?: { response?: string; error?: unknown }; stuckAllocation?: boolean } = {}) {
  const calls: string[] = [];
  const statusListeners = new Set<(status: string) => void>();
  let proofs = 0, txs = 0, drys = 0;
  let transactionArgs: unknown[] = [];
  let messageArgs: unknown[] = [];
  let loginReason: string | undefined;
  const ring = (lite: boolean) => ({ chainId: PEOPLE_GENESIS, junctions: [
    { tag: 'PalletInstance', value: 67 },
    { tag: 'CollectionId', value: bytesToHex(new TextEncoder().encode((lite ? 'pop:polkadot.network/people-lite' : 'pop:polkadot.network/people').padEnd(32, ' '))) },
  ] });
  class Manager {
    async connect() { calls.push('connect'); return { ok: true, value: [] }; }
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
  const accounts = {
    requestLogin(reason?: string) {
      loginReason = reason;
      return { match: async (ok: (response: string) => unknown, err: (error: unknown) => unknown) => options.login?.error ? err(options.login.error) : ok(options.login?.response ?? 'Success') };
    },
    subscribeAccountConnectionStatus(callback: (status: string) => void) {
      statusListeners.add(callback);
      return { unsubscribe: () => statusListeners.delete(callback) };
    },
  };
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
  const origins: unknown[] = [];
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
    isInsideContainer: async () => !options.outside,
    getAccountsProvider: async () => accounts,
    createChainClient: async () => { calls.push('client'); return { raw: { assetHub: {} }, assetHub: { query: { Assets: { Account: { getValue: async () => ({ balance: options.pgasBalance ?? 0n }) } } } }, destroy: () => calls.push('destroy-client') }; },
    SignerManager: Manager,
    createContractRuntimeFromClient: () => ({}),
    isContractAccountMapped: async () => ({ ok: true, value: options.mapped !== false }),
    ensureContractAccountMapped: async () => { calls.push('map'); return { ok: true }; },
    createContractFromClient: (_client: unknown, _descriptor: unknown, _address: unknown, _abi: unknown, defaults: { defaultOrigin?: string }) => { origins.push(defaults.defaultOrigin); return faucet; },
    requestResourceAllocation: async () => { calls.push('pgas'); return options.stuckAllocation ? new Promise(() => {}) : { ok: true, value: ['Allocated'] }; },
  } as unknown as FaucetDependencies;
  return {
    dependencies, calls, origins, statusListeners,
    get counts() { return { proofs, txs, drys }; }, get transactionArgs() { return transactionArgs; }, get messageArgs() { return messageArgs; }, get loginReason() { return loginReason; },
  };
}
async function open(mock: ReturnType<typeof setup>): Promise<FaucetHost> {
  const host = await openFaucet(contract, 'faucet.dot', mock.dependencies);
  assert.ok(host);
  return host;
}
async function connect(mock: ReturnType<typeof setup>) {
  const account = await (await open(mock)).connect();
  assert.ok(account);
  return account;
}

test('claim forwards the v2 ABI, SCALE proof and product signer, and reports what each chain got', async () => {
  const mock = setup();
  const host = await open(mock);
  const faucet = (await host.connect())!;
  const progress: string[] = [];
  const receipt = await faucet.claim(recipient, (message) => progress.push(message));
  assert.deepEqual(mock.calls.slice(1), ['connect', 'pgas', 'proof', 'dry', 'tx']);
  assert.deepEqual(mock.messageArgs, [20000n, recipient]);
  const args = mock.transactionArgs;
  assert.equal(args[0], 2); assert.equal(args[1], recipient);
  assert.equal((args[2] as string).slice(0, 6), '0x450c');
  assert.equal(args[3], alias); assert.equal(args[4], 3); assert.equal(args[5], 57);
  const { onStatus, ...submit } = args[6] as { onStatus: (status: string) => void };
  assert.deepEqual(submit, { signer: 'product-signer', waitFor: 'finalized' });
  onStatus('broadcasting'); onStatus('in-block');
  assert.deepEqual(progress.slice(-2), ['Submitting the claim', 'Waiting for finality']);
  assert.deepEqual(receipt, {
    txHash: `0x${'aa'.repeat(32)}`, recipient,
    paid: [{ id: 1000, pas: 250000000000n, pusd: 25000000n }],
    skipped: [{ id: 1004, reason: 'PayoutFailed' }],
  });
  faucet.destroy(); host.destroy();
  assert.deepEqual(mock.calls.slice(-2), ['destroy-signer', 'destroy-client']);
});
test('outside a Polkadot host the faucet does not open', async () => {
  const mock = setup({ outside: true });
  assert.equal(await openFaucet(contract, 'faucet.dot', mock.dependencies), null);
  assert.deepEqual(mock.calls, []);
});
test('anyone can read the faucet: views need no account, so they use the SDK query origin', async () => {
  const mock = setup();
  const state = await (await open(mock)).refresh();
  assert.deepEqual([state.pasBalance, state.pusdBalance], [100000000000000n, 90000000000000n]);
  assert.deepEqual([state.lite, state.full], [{ enabled: true, pas: 250000000000n, pusd: 25000000n }, { enabled: true, pas: 250000000000n, pusd: 25000000n }]);
  assert.equal(mock.origins.length, 1);
  assert.notEqual(mock.origins[0], 'product-account');
  assert.ok(!mock.calls.includes('connect'));
});
test('nobody signed in to the host leaves the faucet read-only; other refusals pass through', async () => {
  const signedOut = setup({ productAccountError: hostError('NotConnected') });
  assert.equal(await (await open(signedOut)).connect(), null);
  assert.ok(signedOut.calls.includes('destroy-signer'));
  const invalid = setup({ productAccountError: hostError('DomainNotValid') });
  await assert.rejects((await open(invalid)).connect(), /Domain → V1 → DomainNotValid/);
});
test('signing in asks the host for its sign-in flow, which a person can cancel', async () => {
  for (const [response, signedIn] of [['Success', true], ['AlreadyConnected', true], ['Rejected', false]] as const) {
    const mock = setup({ login: { response } });
    assert.equal(await (await open(mock)).signIn(), signedIn);
    assert.equal(mock.loginReason, 'Sign in to claim Paseo test tokens.');
  }
  await assert.rejects((await open(setup({ login: { error: { tag: 'Unsupported' } } }))).signIn(),
    /^Error: Sign in to this Polkadot host with your Polkadot app, then connect again\.$/);
  await assert.rejects((await open(setup({ login: { error: { tag: 'Domain', value: { tag: 'V1', value: { tag: 'Unknown', value: { reason: 'pairing timed out' } } } } } }))).signIn(),
    /^Error: Sign-in failed: .*pairing timed out/);
});
test('the host reports signing in and out until the faucet closes', async () => {
  const mock = setup();
  const host = await open(mock);
  const seen: boolean[] = [];
  const stop = host.onSignInChange((signedIn) => seen.push(signedIn));
  for (const listener of mock.statusListeners) { listener('Disconnected'); listener('Connected'); }
  assert.deepEqual(seen, [false, true]);
  stop();
  assert.equal(mock.statusListeners.size, 0);
  host.onSignInChange(() => {});
  host.destroy();
  assert.equal(mock.statusListeners.size, 0);
});
test('connect reports the personhood tiers the person holds a key for', async () => {
  const cases: [Parameters<typeof setup>[0], number[]][] = [[{}, [2, 1]], [{ heldKeys: ['lite'] }, [1]], [{ listDenied: true }, []]];
  for (const [options, expected] of cases) {
    assert.deepEqual((await connect(setup(options))).heldTiers, expected);
  }
});
test('connecting asks for no fees or mapping; a new account gets fees, then its mapping, at its first claim', async () => {
  const mock = setup({ mapped: false });
  const faucet = await connect(mock);
  assert.deepEqual(mock.calls, ['client', 'connect']);
  const progress: string[] = [];
  await faucet.claim(recipient, (message) => progress.push(message));
  assert.deepEqual(mock.calls.slice(2), ['pgas', 'map', 'pgas', 'proof', 'dry', 'tx']);
  assert.ok(progress.includes('Confirm the one-time account setup in your Polkadot app'));
});
test('accounts with enough PGAS do not consume another host allocation', async () => {
  const mock = setup({ pgasBalance: 30_000_000_000n });
  await (await connect(mock)).claim(recipient, () => {});
  assert.deepEqual(mock.calls.slice(2), ['proof', 'dry', 'tx']);
});
test('a host step that never answers fails the claim and names the step', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = setup({ stuckAllocation: true });
  const claim = (await connect(mock)).claim(recipient, () => {});
  while (!mock.calls.includes('pgas')) await new Promise(setImmediate);
  t.mock.timers.tick(120_000);
  await assert.rejects(claim, /^Error: Preparing transaction fees took too long\. Please try again\.$/);
  assert.equal(mock.counts.txs, 0);
});
test('NotMember permits a lite fallback, while host permission failures stop immediately', async () => {
  const lite = setup({ fullNotMember: true });
  const fallback = await connect(lite);
  assert.deepEqual(fallback.heldTiers, [2, 1]);
  await fallback.claim(recipient, () => {});
  assert.equal(lite.transactionArgs[0], 1);
  assert.deepEqual(fallback.heldTiers, [1]);
  const denied = setup({ permissionDenied: true });
  const faucet = await connect(denied);
  await assert.rejects(faucet.claim(recipient, () => {}), /NotAllowlisted/);
  assert.deepEqual(denied.counts, { proofs: 1, txs: 0, drys: 0 });
});
test('a person paid on some chains can claim the rest; paid on every enabled chain, never reaches signing', async () => {
  const partly = setup({ claimed: [1000] });
  await (await connect(partly)).claim(recipient, () => {});
  assert.equal(partly.counts.txs, 1);
  for (const options of [{ claimed: [1000, 1004] }, { contextMismatch: true }]) {
    const mock = setup(options);
    await assert.rejects((await connect(mock)).claim(recipient, () => {}));
    assert.equal(mock.counts.txs, 0);
  }
});
test('an invalid preflight proof is regenerated once before signing', async () => {
  const mock = setup({ failDryOnce: true });
  await (await connect(mock)).claim(recipient, () => {});
  assert.deepEqual(mock.counts, { proofs: 2, drys: 2, txs: 1 });
});
test('uncertain transaction failure never triggers automatic resubmission', async () => {
  const mock = setup({ failTx: true });
  await assert.rejects((await connect(mock)).claim(recipient, () => {}), /Network disconnected/);
  assert.equal(mock.counts.txs, 1);
});
