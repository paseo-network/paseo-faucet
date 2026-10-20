import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Hex,
  bytesToHex,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  hexToBytes,
  keccak256,
} from 'viem';
import {
  ALICE,
  PUSD_ASSET_ID,
  PUSD_ON_PEOPLE,
  WEI_PER_PLANCK,
  type CallResult,
  type Chain,
  type ChainEvent,
  accountHex,
  call,
  constant,
  contractAccount,
  decodeXcm,
  deploy,
  eventsSince,
  h160,
  head,
  json,
  loadArtifact,
  newBlock,
  open,
  pas,
  pusd,
  query,
  read,
  runtimeCall,
  simulate,
  ss58,
  startNetwork,
  toJson,
  transferPas,
  transferPusd,
  trappedAssets,
  untilEvent,
  xcmCodec,
} from './lib.ts';

const PAS = 10n ** 10n;
const PUSD_UNIT = 10n ** 6n;
const DRIP: Amount = { pas: 25n * PAS, pusd: 25n * PUSD_UNIT };
const PRODUCT_ID = 'faucet.dot';
const EPOCH_SECONDS = 86_400n;
const CHAIN_ID = 420_420_417n;
/** `contextFor` vectors for `faucet.dot` from REFERENCES.md. */
const CONTEXTS: [bigint, Hex][] = [
  [0n, '0x31c1b89cf59d9a9e3feeb55781674e2608785c7743d990f1eabc84f2c185e202'],
  [1n, '0x2e49b0091ac03891906d1ce9354c1287f6bac0a594b95de162a92f10e0703da1'],
  [20_743n, '0x0d15aca61c1575803eaa4d8fc1fff601faa1ae33fd4da030d520c969b639c147'],
];
const XCM_PRECOMPILE = '0x00000000000000000000000000000000000a0000';
const PUSD_ERC20 = '0x02FaF21d00000000000000000000000001200000';
/** The pUSD issuer, an account older than auto-mapping. */
const UNMAPPED = '5FX9eGJYqJTmjJDQrQpzEjGh7qQHNscW9uL1X17aXkiFN6u1';
const RELAY_RPC = 'wss://paseo-rpc.n.dwellir.com';
/** `remoteFee` and `maxDeliveryFee` must be at least this multiple of the fees measured for their destination. */
const FEE_MARGIN = 10n;

const [NONE, LOCAL, TELEPORT, RESERVE] = [0, 1, 2, 3];
const SKIP = ['None', 'BelowMinimum', 'InsufficientPas', 'PayoutFailed'];
const LITE = 1;

interface Amount {
  pas: bigint;
  pusd: bigint;
}

interface Entry {
  id: number;
  enabled: boolean;
  pasTransfer: number;
  pusdTransfer: number;
  remoteFee: bigint;
  maxDeliveryFee: bigint;
  minPas: bigint;
  minPusd: bigint;
}

/** `base` under another id and transfer kinds, disabled. */
const variant = (base: Entry, id: number, pasTransfer: number, pusdTransfer: number): Entry => ({
  ...base,
  id,
  enabled: false,
  pasTransfer,
  pusdTransfer,
  minPusd: pusdTransfer === NONE ? 0n : base.minPusd,
});

const out = (path: string) => fileURLToPath(new URL(`../contracts/out/${path}`, import.meta.url));
const faucetArtifact = loadArtifact(out('FaucetHarness.sol/FaucetHarness.json'));
const deployArtifact = loadArtifact(out('Deploy.s.sol/Deploy.json'));
const abi = faucetArtifact.abi;
const xcmAbi = loadArtifact(out('IXcm.sol/IXcm.json')).abi;
const erc20Abi = loadArtifact(out('IERC20.sol/IERC20.json')).abi;

const here = { parents: 1, interior: { type: 'Here' } };
const pusdId = {
  parents: 0,
  interior: {
    type: 'X2',
    value: [
      { type: 'PalletInstance', value: 50 },
      { type: 'GeneralIndex', value: BigInt(PUSD_ASSET_ID) },
    ],
  },
};
const location = (id: number) =>
  id === 0 ? here : { parents: 1, interior: { type: 'X1', value: { type: 'Parachain', value: id } } };
const fungible = (id: unknown, amount: bigint) => ({ id, fun: { type: 'Fungible', value: amount } });
const definite = (kind: number, asset: unknown) => ({
  type: kind === TELEPORT ? 'Teleport' : 'ReserveDeposit',
  value: { type: 'Definite', value: [asset] },
});
const depositAll = (count: number, to: Hex) => ({
  type: 'DepositAsset',
  value: {
    assets: { type: 'Wild', value: { type: 'AllCounted', value: count } },
    beneficiary: { parents: 0, interior: { type: 'X1', value: { type: 'AccountId32', value: { id: to } } } },
  },
});

/** The program the contract must build for `d`, in the form `decodeXcm` returns. */
function expectedProgram(d: Entry, to: Hex, amount: Amount) {
  const withdrawn = amount.pusd
    ? [fungible(pusdId, amount.pusd), fungible(here, amount.pas)]
    : [fungible(here, amount.pas)];
  const deposit = depositAll(withdrawn.length, to);
  const instructions =
    d.pasTransfer === LOCAL
      ? [{ type: 'WithdrawAsset', value: withdrawn }, deposit]
      : [
          { type: 'WithdrawAsset', value: withdrawn },
          { type: 'SetFeesMode', value: { jit_withdraw: true } },
          {
            type: 'InitiateTransfer',
            value: {
              destination: location(d.id),
              remote_fees: definite(d.pasTransfer, fungible(here, d.remoteFee)),
              preserve_origin: false,
              assets: [
                definite(d.pasTransfer, fungible(here, amount.pas - d.remoteFee)),
                ...(amount.pusd ? [definite(d.pusdTransfer, fungible(pusdId, amount.pusd))] : []),
              ],
              remote_xcm: [{ type: 'RefundSurplus' }, deposit],
            },
          },
        ];
  return toJson({ type: 'V5', value: instructions });
}

const newAccount = (): Hex => bytesToHex(randomBytes(32));
const max = (values: bigint[]) => values.reduce((a, b) => (a > b ? a : b));
const u256 = (limbs: bigint[]) => limbs.reduceRight((value, limb) => (value << 64n) | limb, 0n);
const be = (value: bigint | number, bytes: number) => BigInt(value).toString(16).padStart(2 * bytes, '0');
const event = (r: CallResult, pallet: string, name: string) =>
  r.events.find((e) => e.pallet === pallet && e.name === name)?.value;
const hex = (v: Hex | Uint8Array): Hex => (typeof v === 'string' ? v : bytesToHex(v));
const fromAssetHub = (e: ChainEvent) =>
  e.pallet === 'MessageQueue' && e.value?.origin?.type === 'Sibling' && e.value.origin.value === 1000;
const cost = (r: CallResult) => ({
  weight: r.weight,
  storageDeposit: r.deposit,
  txFee: event(r, 'TransactionPayment', 'TransactionFeePaid')?.actual_fee,
  xcmUsed: event(r, 'PolkadotXcm', 'Attempted')?.outcome.value.used,
});

async function liveRelay(paraIds: number[]) {
  const relay = await open(RELAY_RPC);
  try {
    const paraLifecycles: Record<number, string> = {};
    for (const id of paraIds) {
      paraLifecycles[id] = (await query(relay, 'Paras', 'ParaLifecycles', id))?.type ?? 'not registered';
    }
    const { spec_name: specName, spec_version: specVersion } = constant(relay, 'System', 'Version');
    return { endpoint: RELAY_RPC, specName, specVersion, block: await head(relay), paraLifecycles };
  } finally {
    relay.client.destroy();
  }
}

const report: Record<string, unknown> = {};
const net = await startNetwork();
try {
  const { chains } = net;
  const ah = chains.assetHub;
  const ahEd: bigint = constant(ah, 'Balances', 'ExistentialDeposit');

  const summaries: Record<string, unknown> = {};
  for (const c of Object.values<Chain>(chains)) {
    summaries[c.name] = {
      paraId: c.paraId,
      specName: c.specName,
      specVersion: c.specVersion,
      forkedAt: c.forkedAt,
      ...c.source,
      existentialDeposit: constant(c, 'Balances', 'ExistentialDeposit'),
    };
  }
  report.chains = summaries;
  const messaging = await query(ah, 'ParachainSystem', 'RelevantMessagingState');
  const egress: number[] = messaging.egress_channels.map(([id]: [number]) => id);
  report.liveRelay = await liveRelay([ah.paraId, ...egress]);
  report.assetHubHrmpEgress = egress;

  const { address: script } = await deploy(ah, deployArtifact);
  const launch = (await read(ah, script, deployArtifact.abi, 'launch')) as Entry[];
  const people = launch.find((d) => d.id === chains.people.paraId);
  assert.ok(people, 'People is not a launch destination');
  /** Shapes no other entry uses: built, decoded and dry-run on Asset Hub, never delivered. */
  const shapesOnly = [
    variant(people, 2030, RESERVE, RESERVE),
    variant(people, 2034, RESERVE, TELEPORT),
    variant(people, 0, TELEPORT, NONE),
  ];

  const { address: faucet } = await deploy(ah, faucetArtifact, [PRODUCT_ID, EPOCH_SECONDS]);
  const account = contractAccount(faucet);
  const entries = [...launch, ...shapesOnly];
  for (const d of entries) await call(ah, faucet, abi, 'setDestination', [d]);
  assert.deepEqual(await read(ah, faucet, abi, 'destinations'), entries);
  await transferPas(ah, account, 1_000n * PAS);
  await transferPusd(ah, account, 1_000n * PUSD_UNIT);
  /** The XCM version Asset Hub records for `id`; without one it refuses to send there. */
  const xcmVersion = (id: number) =>
    query(ah, 'PolkadotXcm', 'SupportedVersion', 5, { type: 'V5', value: location(id) }).then((v) => v ?? null);
  const holdings = async (who: string): Promise<Amount> => ({ pas: await pas(ah, who), pusd: await pusd(ah, who) });
  report.harness = {
    productId: PRODUCT_ID,
    epochSeconds: EPOCH_SECONDS,
    address: faucet,
    account,
    compiler: faucetArtifact.compiler,
    bytecodeKeccak: keccak256(faucetArtifact.bytecode),
  };

  // 1. Formats through the real ISystem, and the views.
  for (const [epoch, context] of CONTEXTS) assert.equal(await read(ah, faucet, abi, 'contextFor', [epoch]), context);
  const epoch = (await read(ah, faucet, abi, 'currentEpoch')) as bigint;
  assert.equal(epoch, (await query(ah, 'Timestamp', 'Now')) / 1000n / EPOCH_SECONDS);
  const someone = newAccount();
  const message = (await read(ah, faucet, abi, 'messageFor', [epoch, someone])) as Hex;
  const domain = Buffer.from('paseo-faucet:v2').toString('hex');
  const layout = `${domain}${faucet.slice(2)}${be(CHAIN_ID, 8)}${be(epoch, 8)}${someone.slice(2)}`;
  assert.equal(message, `0x${layout}`);
  assert.equal(hexToBytes(message).length, 83);
  const [viewPas, viewPusd] = (await read(ah, faucet, abi, 'balances')) as [bigint, bigint];
  const funded = await holdings(account);
  assert.deepEqual({ pas: viewPas, pusd: viewPusd }, { pas: funded.pas - ahEd, pusd: funded.pusd });
  report.formats = {
    contextFor: Object.fromEntries(CONTEXTS),
    currentEpoch: epoch,
    messageFor: { epoch, recipient: someone, message, length: 83, chainId: CHAIN_ID },
    balancesView: {
      pas: viewPas,
      pusd: viewPusd,
      systemFree: funded.pas,
      note: 'balances() reports free PAS minus the existential deposit',
    },
  };

  // A drip reaches the real IPersonhood, which rejects an empty proof.
  for (const tier of [1, 2]) await call(ah, faucet, abi, 'setTier', [tier, { enabled: true, ...DRIP }]);
  await call(ah, faucet, abi, 'setMaxDripsPerEpoch', [1000]);
  const drips = [];
  for (const tier of [1, 2]) {
    const args = [tier, newAccount(), '0x00', newAccount(), 0, 0];
    const sim = await simulate(ah, faucet, abi, 'drip', args, { allowRevert: true });
    assert.equal(sim.revert?.errorName, 'InvalidProof');
    drips.push({ tier, proof: '0x00', revert: 'InvalidProof', weight: sim.weight });
  }
  report.dripWithEmptyProof = drips;

  const programs: unknown[] = [];
  /** Traces `pay`, checks the program the contract hands to the XCM precompile and records it. */
  async function payProgram(label: string, d: Entry, to: Hex, amount: Amount) {
    const data = encodeFunctionData({ abi, functionName: 'pay', args: [d.id, to, amount.pas, amount.pusd] });
    const from = await h160(ah, ALICE);
    const input = { input: hexToBytes(data) };
    const tx = { from, to: faucet, input, authorization_list: [], blob_versioned_hashes: [], blobs: [] };
    const tracer = { type: 'CallTracer', value: { with_logs: false, only_top_call: false } };
    const trace = await runtimeCall(ah, 'ReviveApi', 'trace_call', tx, tracer);
    if (!trace.success) throw new Error(`trace_call failed: ${json(trace.value)}`);
    const calls = trace.value.value.calls
      .filter((c: { to: Hex }) => c.to === XCM_PRECOMPILE)
      .map((c: { input: Uint8Array }) => decodeFunctionData({ abi: xcmAbi, data: bytesToHex(c.input) }));
    assert.deepEqual(
      calls.map((c: { functionName: string }) => c.functionName),
      ['weighMessage', 'execute'],
    );
    const [program, weight] = calls[1].args as [Hex, unknown];
    assert.equal(calls[0].args[0], program, 'weighed and executed programs differ');
    assert.deepEqual(decodeXcm(ah, program), expectedProgram(d, to, amount), `${label}: unexpected program`);
    const codec = xcmCodec(ah);
    assert.equal(bytesToHex(codec.enc(codec.dec(program))), program, `${label}: not canonical`);
    programs.push({ case: label, destination: d.id, pas: amount.pas, pusd: amount.pusd, program, weight });
  }
  const shapes = [];
  for (const d of shapesOnly) {
    const amount = { pas: DRIP.pas, pusd: d.pusdTransfer === NONE ? 0n : DRIP.pusd };
    const to = newAccount();
    await payProgram(`shape only, destination ${d.id}`, d, to, amount);
    const sim = await simulate(ah, faucet, abi, 'pay', [d.id, to, amount.pas, amount.pusd], { allowRevert: true });
    shapes.push({ ...d, xcmVersion: await xcmVersion(d.id), localDryRun: sim.revert?.errorName ?? 'ok' });
  }
  report.shapesOnly = shapes;

  // 2. SP-02: local deposits on Asset Hub.
  const assetHub = launch.find((d) => d.pasTransfer === LOCAL);
  assert.ok(assetHub, 'Asset Hub is not a launch destination');
  assert.equal(assetHub.minPas, ahEd);
  assert.equal(assetHub.minPusd, (await query(ah, 'Assets', 'Asset', PUSD_ASSET_ID)).min_balance);
  const isMapped = async (who: Hex) =>
    (await query(ah, 'Revive', 'OriginalAccount', await h160(ah, who))) !== undefined;
  const exists = async (who: Hex) => {
    const info = await query(ah, 'System', 'Account', ss58(who));
    return info.providers + info.sufficients > 0;
  };
  const mapped = newAccount();
  await transferPas(ah, mapped, PAS);
  const evm = bytesToHex(randomBytes(20));
  const recipients = [
    { recipient: 'mapped', account: mapped, amount: DRIP, mapped: true, existed: true },
    { recipient: 'unmapped', account: accountHex(UNMAPPED), amount: DRIP, mapped: false, existed: true },
    { recipient: 'new', account: newAccount(), amount: DRIP, mapped: false, existed: false },
    { recipient: '0xEE', account: `${evm}${'ee'.repeat(12)}` as Hex, amount: DRIP, mapped: false, existed: false },
    {
      recipient: 'new, minimum drip',
      account: newAccount(),
      amount: { pas: assetHub.minPas, pusd: assetHub.minPusd },
      mapped: false,
      existed: false,
    },
  ];
  const local = [];
  for (const r of recipients) {
    const state = { mapped: await isMapped(r.account), existed: await exists(r.account) };
    assert.deepEqual(state, { mapped: r.mapped, existed: r.existed }, r.recipient);
    await payProgram(`Asset Hub, ${r.recipient}`, assetHub, r.account, r.amount);
    const before = { faucet: await holdings(account), recipient: await holdings(r.account) };
    const from = await head(ah);
    const res = await call(ah, faucet, abi, 'pay', [assetHub.id, r.account, r.amount.pas, r.amount.pusd]);
    const after = { faucet: await holdings(account), recipient: await holdings(r.account) };
    const diff = (a: Amount, b: Amount) => ({ pas: a.pas - b.pas, pusd: a.pusd - b.pusd });
    assert.deepEqual(diff(after.recipient, before.recipient), r.amount);
    assert.deepEqual(diff(before.faucet, after.faucet), r.amount);
    assert.equal(trappedAssets(await eventsSince(ah, from)).length, 0);
    let evmView;
    if (r.recipient === '0xEE') {
      assert.equal(await runtimeCall(ah, 'ReviveApi', 'account_id', evm), ss58(r.account));
      evmView = {
        address: evm,
        balanceWei: u256(await runtimeCall(ah, 'ReviveApi', 'balance', evm)),
        pusdBalanceOf: await read(ah, PUSD_ERC20, erc20Abi, 'balanceOf', [evm]),
      };
      assert.equal(evmView.balanceWei, (r.amount.pas - ahEd) * WEI_PER_PLANCK);
      assert.equal(evmView.pusdBalanceOf, r.amount.pusd);
    }
    local.push({ ...r, balanceAfter: after.recipient, evmView, ...cost(res) });
  }

  const victim = newAccount();
  const belowEd = { pas: ahEd - 1n, pusd: 0n };
  await payProgram('Asset Hub, forced failure', assetHub, victim, belowEd);
  const beforeFailure = await holdings(account);
  const failureFrom = await head(ah);
  const failArgs = [assetHub.id, victim, belowEd.pas, belowEd.pusd];
  const failed = await call(ah, faucet, abi, 'pay', failArgs, { allowRevert: true });
  const failureEvents = await eventsSince(ah, failureFrom);
  assert.equal(failed.ok, false);
  assert.equal(failed.revert?.errorName, 'PayoutFailed');
  assert.deepEqual(await holdings(account), beforeFailure);
  assert.equal(await exists(victim), false);
  assert.equal(trappedAssets(failureEvents).length, 0);
  assert.ok(!failureEvents.some((e) => e.pallet === 'PolkadotXcm'), 'XCM effects persisted');
  report.sp02 = {
    cases: local,
    forcedFailure: {
      recipient: victim,
      amount: belowEd,
      revert: 'PayoutFailed',
      dispatchError: event(failed, 'System', 'ExtrinsicFailed')?.dispatch_error,
      faucetUnchanged: true,
      trapped: 0,
      ...cost(failed),
    },
  };

  // 3. SP-04: teleports to People.
  const remote = [];
  const launchEntries: unknown[] = [{ chain: ah.name, ...assetHub, existentialDeposit: ahEd }];
  for (const d of launch.filter((e) => e.pasTransfer !== LOCAL)) {
    const dest = Object.values<Chain>(chains).find((c) => c.paraId === d.id);
    assert.ok(dest, `no fork of destination ${d.id}`);
    const ed: bigint = constant(dest, 'Balances', 'ExistentialDeposit');
    assert.equal(d.minPas, ed + d.remoteFee);
    assert.equal(d.minPusd, (await query(dest, 'Assets', 'Asset', PUSD_ON_PEOPLE)).min_balance);
    const metadata = await query(dest, 'Assets', 'Metadata', PUSD_ON_PEOPLE);
    assert.equal(new TextDecoder().decode(metadata.name), 'Digital Dollar');
    const cases = [];
    for (const [label, sent] of [
      ['drip', DRIP],
      ['minimum drip', { pas: d.minPas, pusd: d.minPusd }],
    ] as const) {
      const to = newAccount();
      await payProgram(`${dest.name}, ${label}`, d, to, sent);
      const before = await holdings(account);
      const ahFrom = await head(ah);
      const destFrom = await head(dest);
      const res = await call(ah, faucet, abi, 'pay', [d.id, to, sent.pas, sent.pusd]);
      const after = await holdings(account);
      const destEvents = await untilEvent(dest, destFrom, fromAssetHub);
      const [processed, ...more] = destEvents.filter(fromAssetHub);
      assert.ok(processed?.name === 'Processed' && processed.value.success, `${dest.name}: not processed`);
      assert.equal(more.length, 0);
      assert.equal(trappedAssets(await eventsSince(ah, ahFrom)).length, 0);
      assert.equal(trappedAssets(destEvents).length, 0);
      assert.equal(before.pusd - after.pusd, sent.pusd);
      const creditedPas = await pas(dest, to);
      const creditedPusd = await pusd(dest, to);
      assert.equal(creditedPusd, sent.pusd);
      const executionFee = sent.pas - creditedPas;
      assert.ok(creditedPas >= ed, `${dest.name}: credited below the existential deposit`);
      assert.ok(executionFee > 0n && executionFee * FEE_MARGIN <= d.remoteFee, `${dest.name}: remote fee margin`);
      cases.push({
        case: label,
        recipient: to,
        sent,
        creditedPas,
        creditedPusd,
        deliveryFee: before.pas - after.pas - sent.pas,
        executionFee,
        destinationWeightUsed: processed.value.weight_used,
        trapped: 0,
        ...cost(res),
      });
    }
    const deliveryFee = max(cases.map((c) => c.deliveryFee));
    assert.ok(deliveryFee * FEE_MARGIN <= d.maxDeliveryFee, `${dest.name}: delivery fee margin`);

    // The bound on the faucet's outflow, measured around the drip's own delivery fee.
    const dripDeliveryFee = cases[0]!.deliveryFee;
    const payWithBound = async (maxDeliveryFee: bigint) => {
      await call(ah, faucet, abi, 'setDestination', [{ ...d, maxDeliveryFee }]);
      const args = [d.id, newAccount(), DRIP.pas, DRIP.pusd];
      return (await simulate(ah, faucet, abi, 'pay', args, { allowRevert: true })).revert?.errorName ?? 'ok';
    };
    const deliveryFeeBound = {
      deliveryFee: dripDeliveryFee,
      atTheFee: await payWithBound(dripDeliveryFee),
      belowTheFee: await payWithBound(dripDeliveryFee - 1n),
    };
    await call(ah, faucet, abi, 'setDestination', [d]);
    assert.deepEqual(deliveryFeeBound, { deliveryFee: dripDeliveryFee, atTheFee: 'ok', belowTheFee: 'PayoutFailed' });

    remote.push({ destination: d.id, chain: dest.name, cases, deliveryFeeBound });
    const maxExecutionFee = max(cases.map((c) => c.executionFee));
    launchEntries.push({
      chain: dest.name,
      ...d,
      existentialDeposit: ed,
      xcmVersion: await xcmVersion(d.id),
      maxExecutionFee,
      remoteFeeMargin: d.remoteFee / maxExecutionFee,
      deliveryFee,
      deliveryFeeMargin: d.maxDeliveryFee / deliveryFee,
    });
  }
  report.sp04 = remote;
  report.launchEntries = launchEntries;

  // 4. REQ-18: one claim pays every enabled destination; a destination whose payout fails reverts alone.
  const peopleChain = chains.people;
  const { remoteFee } = people;
  const faucetEvents = (r: CallResult) =>
    r.events
      .filter((e) => e.pallet === 'Revive' && e.name === 'ContractEmitted' && hex(e.value.contract) === faucet)
      .map((e) => {
        const log = decodeEventLog({ abi, data: hex(e.value.data), topics: e.value.topics.map(hex) });
        const args = log.args as Record<string, any>;
        return log.eventName === 'Dripped'
          ? { event: 'Dripped', destination: args.destinationId, pas: args.pas, pusd: args.pusd }
          : { event: log.eventName, destination: args.destinationId, reason: SKIP[args.reason] };
      });
  const dripped = (id: number, amount: Amount) => ({ event: 'Dripped', destination: id, ...amount });
  const paidOn = async (alias: Hex, id: number) =>
    read(ah, faucet, abi, 'hasClaimed', [await read(ah, faucet, abi, 'currentEpoch'), LITE, alias, id]);
  const dripsNow = async () =>
    read(ah, faucet, abi, 'dripsInEpoch', [await read(ah, faucet, abi, 'currentEpoch')]) as Promise<number>;
  /** Claims for `alias` without a proof; checks what reached each chain and that nothing was trapped. */
  async function claim(alias: Hex, to: Hex, expected: unknown[], peoplePaid: boolean) {
    const before = { faucet: await holdings(account), recipient: await holdings(to), drips: await dripsNow() };
    const ahFrom = await head(ah);
    const peopleFrom = await head(peopleChain);
    const res = await call(ah, faucet, abi, 'dripWithoutProof', [LITE, to, alias]);
    const events = faucetEvents(res);
    assert.deepEqual(toJson(events), toJson(expected));
    assert.equal(trappedAssets(await eventsSince(ah, ahFrom)).length, 0);
    const assetHubPaid = events.some((e) => e.event === 'Dripped' && e.destination === ah.paraId);
    const received = await holdings(to);
    const diff = (a: Amount, b: Amount) => ({ pas: a.pas - b.pas, pusd: a.pusd - b.pusd });
    assert.deepEqual(diff(received, before.recipient), assetHubPaid ? DRIP : { pas: 0n, pusd: 0n });
    const sent = res.events.filter((e) => e.pallet === 'XcmpQueue' && e.name === 'XcmpMessageSent').length;
    assert.equal(sent, peoplePaid ? 1 : 0);
    let arrived;
    if (peoplePaid) {
      const peopleEvents = await untilEvent(peopleChain, peopleFrom, fromAssetHub);
      const processed = peopleEvents.find(fromAssetHub);
      assert.ok(processed?.name === 'Processed' && processed.value.success, 'People: not processed');
      assert.equal(trappedAssets(peopleEvents).length, 0);
      arrived = { pas: await pas(peopleChain, to), pusd: await pusd(peopleChain, to) };
      assert.equal(arrived.pusd, DRIP.pusd);
      assert.ok(arrived.pas > DRIP.pas - remoteFee, 'People: credited less than the drip less remoteFee');
    } else {
      await newBlock(peopleChain);
      assert.ok(!(await eventsSince(peopleChain, peopleFrom)).some(fromAssetHub), 'People: a skipped leg arrived');
    }
    const spent = diff(before.faucet, await holdings(account));
    return {
      events,
      faucetSpent: spent,
      assetHubCredited: diff(received, before.recipient),
      peopleBalance: arrived,
      dripsInEpoch: { before: before.drips, after: await dripsNow() },
      weight: res.weight,
      storageDeposit: res.deposit,
      txFee: event(res, 'TransactionPayment', 'TransactionFeePaid')?.actual_fee,
    };
  }

  const both = newAccount();
  const aliasBoth = newAccount();
  const paysBoth = await claim(aliasBoth, both, [dripped(ah.paraId, DRIP), dripped(people.id, DRIP)], true);
  assert.equal(paysBoth.dripsInEpoch.after, paysBoth.dripsInEpoch.before + 1);
  assert.equal(paysBoth.faucetSpent.pusd, 2n * DRIP.pusd);
  assert.ok(paysBoth.faucetSpent.pas - 2n * DRIP.pas <= people.maxDeliveryFee, 'delivery fee above the bound');

  // People's payout reverts on the bound, alone: Asset Hub is paid and People stays claimable.
  await call(ah, faucet, abi, 'setDestination', [{ ...people, maxDeliveryFee: 1n }]);
  const skipped = { event: 'DripSkipped', destination: people.id, reason: 'PayoutFailed' };
  const to = newAccount();
  const alias = newAccount();
  const skipsPeople = await claim(alias, to, [dripped(ah.paraId, DRIP), skipped], false);
  assert.deepEqual(skipsPeople.faucetSpent, DRIP);
  assert.equal(skipsPeople.dripsInEpoch.after, skipsPeople.dripsInEpoch.before + 1);
  assert.deepEqual([await paidOn(alias, ah.paraId), await paidOn(alias, people.id)], [true, false]);
  const allFail = async () => {
    const sim = await simulate(ah, faucet, abi, 'dripWithoutProof', [LITE, newAccount(), newAccount()], {
      allowRevert: true,
    });
    return sim.revert?.errorName ?? 'ok';
  };
  await call(ah, faucet, abi, 'disableDestination', [ah.paraId]);
  const nothingPaid = await allFail();
  assert.equal(nothingPaid, 'PayoutFailed');
  await call(ah, faucet, abi, 'setDestination', [assetHub]);
  await call(ah, faucet, abi, 'setDestination', [people]);

  const paysSkipped = await claim(alias, to, [dripped(people.id, DRIP)], true);
  assert.equal(paysSkipped.dripsInEpoch.after, paysSkipped.dripsInEpoch.before);
  assert.deepEqual([await paidOn(alias, ah.paraId), await paidOn(alias, people.id)], [true, true]);
  const again = await simulate(ah, faucet, abi, 'dripWithoutProof', [LITE, to, alias], { allowRevert: true });
  assert.equal(again.revert?.errorName, 'AlreadyClaimed');
  report.req18 = {
    tier: LITE,
    drip: DRIP,
    paysEveryDestination: { recipient: both, alias: aliasBoth, ...paysBoth },
    skipsAFailedPayout: {
      recipient: to,
      alias,
      setup: 'People maxDeliveryFee set to 1 plank, below its delivery fee',
      ...skipsPeople,
    },
    nothingPaid: { setup: 'Asset Hub disabled, People maxDeliveryFee 1 plank', revert: nothingPaid },
    paysTheSkippedDestinationLater: { recipient: to, alias, setup: 'People entry restored', ...paysSkipped },
    claimAgain: again.revert?.errorName,
  };
  report.programs = programs;
} finally {
  await net.close();
}

const path = fileURLToPath(new URL('../docs/evidence/fork-check.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(toJson(report), null, 2)}\n`);
console.log(`FORK CHECK OK: ${path}`);
