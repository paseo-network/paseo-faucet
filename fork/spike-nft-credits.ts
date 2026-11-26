import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Hex, bytesToHex, hexToBytes, parseAbi, toFunctionSelector } from 'viem';
import {
  ALICE,
  type Chain,
  type ChainEvent,
  accountHex,
  call,
  contractAccount,
  head,
  instantiate,
  json,
  newBlock,
  query,
  read,
  runtimeCall,
  ss58,
  startNetwork,
  submit,
  transferPas,
  trappedAssets,
  untilEvent,
  xcmCodec,
} from './lib.ts';

const PAS = 10n ** 10n;
const FAUCET_GAME_BASE = 0x8000_0000;
const SLOTS_PER_GAME = 18;
const GROUP_SIZE = 6;
const JOBS_COLLECTION = 18;
const grantAbi = parseAbi(['function grant(bytes32 claimant)', 'function program(bytes32 claimant) view returns (bytes)']);
const grantBlob = readFileSync(new URL('../pvm/nft-credit-grant/nft-credit-grant.polkavm', import.meta.url));

interface Slot {
  gameIndex: number;
  round: number;
  attesterPosition: number;
}

function syntheticAttester({ gameIndex, round, attesterPosition }: Slot): string {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode('dim2fct'));
  new DataView(bytes.buffer).setUint32(8, gameIndex, true);
  bytes[12] = round;
  bytes[13] = attesterPosition;
  return ss58(bytesToHex(bytes));
}

const nthSlot = (granted: number): Slot => ({
  gameIndex: FAUCET_GAME_BASE + Math.floor(granted / SLOTS_PER_GAME),
  round: Math.floor((granted % SLOTS_PER_GAME) / GROUP_SIZE),
  attesterPosition: granted % GROUP_SIZE,
});

const fund = (chain: Chain, who: string, free: bigint) =>
  chain.client._request('dev_setStorage', [
    { System: { Account: [[[who], { providers: 1, data: { free: free.toString() } }]] } },
  ]);

const here = { parents: 1, interior: { type: 'Here' } };
const pasAsset = (amount: bigint) => ({ id: here, fun: { type: 'Fungible', value: amount } });
const localAccount = (id: Hex) => ({
  parents: 0,
  interior: { type: 'X1', value: { type: 'AccountId32', value: { network: undefined, id } } },
});

async function proxiedGrant(people: Chain, sudoKey: string, claimant: string, slot: Slot): Promise<Uint8Array> {
  const grant = people.api.tx.NftCredits.testnet_grant_nft_claim_credit({
    claimant: { type: 'Account', value: claimant },
    attester: { type: 'Account', value: syntheticAttester(slot) },
    game_index: slot.gameIndex,
    round: slot.round,
    attester_position: slot.attesterPosition,
  });
  const sudo = people.api.tx.Sudo.sudo({ call: grant.decodedCall });
  return people.api.tx.Proxy.proxy({
    real: { type: 'Id', value: sudoKey },
    force_proxy_type: undefined,
    call: sudo.decodedCall,
  }).getEncodedData();
}

function grantProgram(ah: Chain, peopleId: number, contractId: Hex, proxiedCall: Uint8Array, fee: bigint) {
  return xcmCodec(ah).enc({
    type: 'V5',
    value: [
      { type: 'WithdrawAsset', value: [pasAsset(fee)] },
      { type: 'SetFeesMode', value: { jit_withdraw: true } },
      {
        type: 'InitiateTransfer',
        value: {
          destination: { parents: 1, interior: { type: 'X1', value: { type: 'Parachain', value: peopleId } } },
          remote_fees: { type: 'Teleport', value: { type: 'Definite', value: [pasAsset(fee)] } },
          preserve_origin: true,
          assets: [],
          remote_xcm: [
            { type: 'AliasOrigin', value: localAccount(contractId) },
            {
              type: 'Transact',
              value: { origin_kind: { type: 'SovereignAccount' }, fallback_max_weight: undefined, call: proxiedCall },
            },
            { type: 'ExpectTransactStatus', value: { type: 'Success' } },
            { type: 'RefundSurplus' },
            {
              type: 'DepositAsset',
              value: {
                assets: { type: 'Wild', value: { type: 'AllCounted', value: 1 } },
                beneficiary: localAccount(contractId),
              },
            },
          ],
        },
      },
    ],
  });
}

const summarize = (events: ChainEvent[]) =>
  events
    .filter((e) => e.pallet !== 'ParachainSystem')
    .map((e) => `#${e.block} ${e.pallet}.${e.name} ${json(e.value).slice(0, 400)}`)
    .join('\n');

const has = (events: ChainEvent[], pallet: string, name: string) =>
  events.some((e) => e.pallet === pallet && e.name === name);

const net = await startNetwork(['assetHubNext', 'peopleNext']);
try {
  const { assetHubNext: ah, peopleNext: people } = net.chains;
  console.log(`AH ${ah.specName} ${ah.specVersion} para ${ah.paraId} at #${ah.forkedAt}`);
  console.log(`People ${people.specName} ${people.specVersion} para ${people.paraId} at #${people.forkedAt}`);

  const sudoKey: string = await query(people, 'Sudo', 'Key');
  console.log(`People sudo key ${sudoKey}`);
  await fund(people, sudoKey, 1_000_000n * PAS);
  await newBlock(people);
  await fund(ah, ALICE, 1_000_000n * PAS);
  await newBlock(ah);

  const { address } = await instantiate(ah, grantBlob, hexToBytes(accountHex(sudoKey)));
  const contractSs58 = contractAccount(address);
  const contractId = accountHex(contractSs58);
  console.log(`granter ${address} = ${contractSs58}`);
  await transferPas(ah, contractSs58, 100n * PAS);

  const claimant = ss58(bytesToHex(randomBytes(32)));
  const claimantId = accountHex(claimant);
  const mask = (gameIndex = FAUCET_GAME_BASE): Promise<bigint> =>
    query(people, 'NftCredits', 'AwardedNftClaimCredits', gameIndex, { type: 'Account', value: claimant });
  const fromChain = (paraId: number) => (e: ChainEvent) =>
    e.pallet === 'MessageQueue' && e.value?.origin?.type === 'Sibling' && e.value.origin.value === paraId;
  const fromAssetHub = fromChain(ah.paraId);

  const expectProgram = async (label: string, slot: Slot) => {
    const built = await read(ah, address, grantAbi, 'program', [claimantId]);
    const proxied = await proxiedGrant(people, sudoKey, claimant, slot);
    const expected = grantProgram(ah, people.paraId, contractId, proxied, PAS);
    assert.equal(built, bytesToHex(expected), `${label}: the contract built another program`);
  };

  const grant = async (label: string) => {
    const result = await call(ah, address, grantAbi, 'grant', [claimantId]);
    assert.ok(has(result.events, 'PolkadotXcm', 'Sent'), `${label}: no message left Asset Hub`);
  };

  const attempt = async (label: string, slot: Slot) => {
    await expectProgram(label, slot);
    const peopleFrom = await head(people);
    await grant(label);
    const events = await untilEvent(people, peopleFrom, fromAssetHub, 5);
    console.log(`\n== ${label}\n${summarize(events)}`);
    return events;
  };

  const refused = await attempt('without proxy', nthSlot(0));
  assert.ok(!has(refused, 'NftCredits', 'NftClaimCreditAwarded'), 'a credit was awarded without the proxy');
  assert.equal(await mask(), 0n);
  const refusal = refused.find((e) => e.pallet === 'PolkadotXcm' && e.name === 'ProcessXcmError');
  assert.equal(refusal?.value.error.type, 'ExpectationFalse');
  assert.equal(trappedAssets(refused).length, 1);

  const added = await submit(
    people,
    people.api.tx.Proxy.add_proxy({
      delegate: { type: 'Id', value: contractSs58 },
      proxy_type: { type: 'Any' },
      delay: 0,
    }),
    sudoKey,
  );
  assert.ok(has(added, 'Proxy', 'ProxyAdded'), 'add_proxy failed');

  const awarded = (events: ChainEvent[]) => {
    const award = events.find((e) => e.pallet === 'NftCredits' && e.name === 'NftClaimCreditAwarded');
    assert.ok(award, 'no credit was awarded');
    return award.value as { credit: Uint8Array; block: number; leaf_index: number };
  };

  const granted = await attempt('with proxy', nthSlot(1));
  assert.ok(has(granted, 'Proxy', 'ProxyExecuted'), 'the proxy call did not run');
  assert.ok(has(granted, 'Sudo', 'Sudid'), 'the sudo call did not run');
  const first = awarded(granted);
  assert.equal(await mask(), 0b10n);

  const second = awarded(await attempt('second credit in the same round', nthSlot(2)));
  assert.equal(await mask(), 0b110n);
  assert.notEqual(bytesToHex(second.credit), bytesToHex(first.credit), 'two positions of one round gave one credit');

  const shortGrant = await runtimeCall(
    ah,
    'ReviveApi',
    'call',
    ALICE,
    address,
    0n,
    undefined,
    undefined,
    hexToBytes(toFunctionSelector('grant(bytes32)')),
  );
  assert.ok(shortGrant.result.success && shortGrant.result.value.flags & 1, 'a grant with no claimant did not revert');

  await newBlock(people);
  const treeBlocks = [first.block, second.block];
  const delivered = async () =>
    (await Promise.all(treeBlocks.map((b) => query(ah, 'NftClaims', 'CreditTrees', b)))).every(Boolean);
  await newBlock(ah);
  if (!(await delivered())) {
    await fund(people, ALICE, 1_000_000n * PAS);
    await newBlock(people);
    const ahFrom = await head(ah);
    await submit(people, people.api.tx.NftCredits.replay_credit_trees({ blocks: treeBlocks }));
    await untilEvent(ah, ahFrom, fromChain(people.paraId), 5);
    console.log('\ncredit trees resent to Asset Hub');
  }
  assert.ok(await delivered(), 'the credit trees did not reach Asset Hub');

  await fund(ah, claimant, 1_000n * PAS);
  await newBlock(ah);
  const mint = async (award: typeof first) => {
    const proofs = await runtimeCall(people, 'NftCreditsApi', 'nft_claim_credit_proofs', award.block, {
      type: 'Account',
      value: claimant,
    });
    assert.ok(proofs.success, `no proofs for block ${award.block}: ${json(proofs.value)}`);
    const proof = proofs.value.find((p: { leaf_index: number }) => p.leaf_index === award.leaf_index);
    assert.ok(proof, `no proof for leaf ${award.leaf_index} of block ${award.block}`);
    const purse = ss58(bytesToHex(randomBytes(32)));
    const events = await submit(
      ah,
      ah.api.tx.NftClaims.claim({
        claimant: { type: 'Account' },
        block: award.block,
        credit: award.credit,
        leaf_index: award.leaf_index,
        proof: proof.proof,
        collection: JOBS_COLLECTION,
        mint_to: purse,
      }),
      claimant,
    );
    const claimed = events.find((e) => e.pallet === 'NftClaims' && e.name === 'CreditClaimed');
    assert.ok(claimed, `no piece was minted for block ${award.block}`);
    assert.equal(accountHex(claimed.value.owner), accountHex(purse));
    console.log(`minted ${json(claimed.value)}`);
    return claimed.value as { item: number };
  };
  const pieces = [await mint(first), await mint(second)];
  console.log(`items of the two pieces: ${pieces[0].item} and ${pieces[1].item}`);

  for (let count = 3; count < SLOTS_PER_GAME; count++) {
    if (count === GROUP_SIZE) await expectProgram('first slot of round 1', nthSlot(count));
    await grant(`grant ${count}`);
  }
  await expectProgram('first slot of the next game', nthSlot(SLOTS_PER_GAME));
  await grant('first grant of the next game');
  for (let built = 0; (await mask(FAUCET_GAME_BASE + 1)) === 0n; built++) {
    assert.ok(built < 10, 'the next game got no credit');
    await newBlock(people);
  }
  assert.equal(await mask(FAUCET_GAME_BASE + 1), 1n);
  assert.equal(await mask(), (1n << BigInt(SLOTS_PER_GAME)) - 2n);
  console.log('\nNFT CREDITS SPIKE OK');
} finally {
  await net.close();
}
