import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainInfo, claimBlocker, encodeProof, formatAmount, isEthereumDerived, netPas, parseRecipient, planPayouts, type Destination, type Snapshot } from '../src/model';

const alice = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ethereum = '0x1234567890123456789012345678901234567890';
const enabled = { enabled: true, pas: 250_000_000_000n, pusd: 25_000_000n };
const assetHub: Destination = { id: 1000, enabled: true, pasTransfer: 1, pusdTransfer: 1, remoteFee: 0n, maxDeliveryFee: 0n, minPas: 100_000_000n, minPusd: 10n };
const people: Destination = { id: 1004, enabled: true, pasTransfer: 2, pusdTransfer: 2, remoteFee: 100_000_000n, maxDeliveryFee: 5_000_000_000n, minPas: 1_100_000_000n, minPusd: 10_000n };
const bulletin: Destination = { id: 1501, enabled: true, pasTransfer: 2, pusdTransfer: 0, remoteFee: 100_000_000n, maxDeliveryFee: 5_000_000_000n, minPas: 1_100_000_000n, minPusd: 0n };
const state: Snapshot = {
  epoch: 20000n, nextEpochStart: 1728086400n, paused: false, cap: 1000, used: 10,
  pasBalance: 10n ** 16n, pusdBalance: 10n ** 16n, lite: enabled, full: enabled,
  destinations: [assetHub, people, bulletin],
};

test('chain display data covers the Paseo chains and any other para id', () => {
  assert.deepEqual([0, 1000, 1004, 1010, 1500, 1501, 1502].map(id => chainInfo(id).name),
    ['Paseo Relay', 'Asset Hub', 'People', 'Bulletin', 'Asset Hub Next', 'Bulletin Next', 'People Next']);
  assert.equal(chainInfo(2034).name, 'Parachain 2034');
});
test('recipients decode to AccountId32, an H160 to its 0xEE account', () => {
  assert.equal(parseRecipient(alice), '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');
  const mapped = `${ethereum}${'ee'.repeat(12)}`;
  assert.equal(parseRecipient(ethereum), mapped);
  assert.equal(isEthereumDerived(parseRecipient(ethereum)), true);
  assert.equal(isEthereumDerived(parseRecipient(alice)), false);
  assert.throws(() => parseRecipient('not-an-address'), /valid Substrate/);
});
test('raw proof is length-prefixed and bounded before submission', () => {
  assert.equal(encodeProof(new Uint8Array(785)).slice(0, 6), '0x450c');
  assert.equal(encodeProof(new Uint8Array(63)).slice(0, 4), '0xfc');
  assert.equal(encodeProof(new Uint8Array(64)).slice(0, 6), '0x0101');
  assert.throws(() => encodeProof(new Uint8Array(1266)));
  assert.throws(() => encodeProof(new Uint8Array()));
});
test('token formatting retains exact large balances and fractional plancks', () => {
  assert.equal(formatAmount(250_000_000_001n, 10), '25.0000000001');
  assert.equal(formatAmount(25_010_000n, 6), '25.01');
  assert.equal(formatAmount(1234567891234567890000000000n, 10), '123,456,789,123,456,789');
});
test('a claim pays every enabled destination, with pUSD only where the chain takes it', () => {
  const { paid, skipped } = planPayouts(state.destinations, state, enabled);
  assert.deepEqual(paid, [
    { id: 1000, pas: enabled.pas, pusd: enabled.pusd },
    { id: 1004, pas: enabled.pas, pusd: enabled.pusd },
    { id: 1501, pas: enabled.pas, pusd: 0n },
  ]);
  assert.deepEqual(skipped, []);
  assert.equal(netPas(paid[1], state.destinations), enabled.pas - people.remoteFee);
  assert.equal(netPas(paid[0], state.destinations), enabled.pas);
  assert.deepEqual(planPayouts([{ ...people, enabled: false }], state, enabled), { paid: [], skipped: [] });
});
test('the plan skips like the contract: below the minimum, or once the balance runs out', () => {
  const small = { ...enabled, pas: people.minPas - 1n };
  assert.deepEqual(planPayouts(state.destinations, state, small).skipped, [
    { id: 1004, reason: 'BelowMinimum' }, { id: 1501, reason: 'BelowMinimum' },
  ]);
  const funds = { ...state, pasBalance: 2n * enabled.pas + people.maxDeliveryFee, pusdBalance: enabled.pusd };
  const { paid, skipped } = planPayouts(state.destinations, funds, enabled);
  assert.deepEqual(paid, [{ id: 1000, pas: enabled.pas, pusd: enabled.pusd }, { id: 1004, pas: enabled.pas, pusd: 0n }]);
  assert.deepEqual(skipped, [{ id: 1501, reason: 'InsufficientPas' }]);
  const lowPusd = { ...enabled, pusd: people.minPusd - 1n };
  assert.deepEqual(planPayouts(state.destinations, state, lowPusd).paid.map(p => p.pusd), [lowPusd.pusd, 0n, 0n]);
});
test('UI eligibility is advisory and blocks paused, disabled, capped, closed and empty states', () => {
  assert.equal(claimBlocker(state, enabled), null);
  assert.match(claimBlocker({ ...state, paused: true }, enabled)!, /paused/);
  assert.match(claimBlocker(state, { ...enabled, enabled: false })!, /disabled/);
  assert.match(claimBlocker({ ...state, used: 1000 }, enabled)!, /used/);
  assert.match(claimBlocker({ ...state, destinations: state.destinations.map(d => ({ ...d, enabled: false })) }, enabled)!, /No chain/);
  assert.match(claimBlocker({ ...state, pasBalance: 0n }, enabled)!, /refill/);
  assert.match(claimBlocker(state, { ...enabled, pas: 1n })!, /minimum/);
  assert.equal(claimBlocker({ ...state, pusdBalance: 0n }, enabled), null);
});
