import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainCatalog, claimBlocker, encodeProof, formatAmount, parseRecipient, type Snapshot } from '../src/model';

const alice = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ethereum = '0x1234567890123456789012345678901234567890';
const enabled = { enabled: true, pas: 250_000_000_000n, pusd: 25_000_000n };
const state: Snapshot = {
  epoch: 20000n, nextEpochStart: 1728086400n, paused: false, cap: 1000, used: 10,
  pasBalance: 10n ** 16n, pusdBalance: 10n ** 16n, lite: enabled, full: enabled,
  destinations: [{ id: 1000, enabled: true, pasTransfer: 1, pusdTransfer: 1, remoteFee: 0n, maxDeliveryFee: 0n, minPas: 100_000_000n, minPusd: 10n }],
};

test('catalog contains the seven requested chains, including both Bulletins', () => {
  assert.deepEqual(chainCatalog().map(c => c.id), [0, 1000, 1004, 1010, 1500, 1501, 1502]);
  assert.equal(new Set(chainCatalog().map(c => c.id)).size, 7);
});
test('SS58 is decoded to AccountId32 without assuming a prefix', () => {
  assert.equal(parseRecipient(alice, 1004), '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');
});
test('Ethereum recipient is mapped only for local Asset Hub', () => {
  const mapped = `${ethereum}${'ee'.repeat(12)}`;
  assert.equal(parseRecipient(ethereum, 1000), mapped);
  assert.throws(() => parseRecipient(ethereum, 1004), /only on Asset Hub/);
  assert.throws(() => parseRecipient(mapped, 1004), /Ethereum-derived/);
  assert.throws(() => parseRecipient('not-an-address', 1000), /valid Substrate/);
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
test('UI eligibility is advisory and blocks paused, unregistered, capped and empty states', () => {
  assert.equal(claimBlocker(state, 1000, enabled), null);
  assert.match(claimBlocker(state, 1010, enabled)!, /not available/);
  assert.match(claimBlocker(state, 1501, enabled)!, /not available/);
  assert.match(claimBlocker({ ...state, paused: true }, 1000, enabled)!, /paused/);
  assert.match(claimBlocker({ ...state, used: 1000 }, 1000, enabled)!, /used/);
  assert.match(claimBlocker({ ...state, pasBalance: 0n }, 1000, enabled)!, /refill/);
  assert.match(claimBlocker({ ...state, pusdBalance: 0n }, 1000, enabled)!, /refill/);
  assert.match(claimBlocker(state, 1000, { ...enabled, pas: 1n })!, /minimum/);
  assert.match(claimBlocker(state, 1000, { ...enabled, enabled: false })!, /disabled/);
});
