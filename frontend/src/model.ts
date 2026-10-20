import { getSs58AddressInfo } from 'polkadot-api';
import { bytesToHex, hexToBytes, type Hex } from 'viem';

export const ASSET_HUB_GENESIS = '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2';
export const PEOPLE_GENESIS = '0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec';
export interface Chain { id: number; name: string; explorer: string; }
export function chainCatalog(): Chain[] {
  return [
    { id: 0, name: 'Paseo Relay', explorer: 'https://paseo.subscan.io' },
    { id: 1000, name: 'Asset Hub', explorer: 'https://assethub-paseo.subscan.io' },
    { id: 1004, name: 'People', explorer: 'https://people-paseo.subscan.io' },
    { id: 1010, name: 'Bulletin', explorer: 'https://polkadot.js.org/apps/' },
    { id: 1500, name: 'Asset Hub Next', explorer: 'https://polkadot.js.org/apps/' },
    { id: 1501, name: 'Bulletin Next', explorer: 'https://polkadot.js.org/apps/' },
    { id: 1502, name: 'People Next', explorer: 'https://polkadot.js.org/apps/' },
  ];
}
export interface Destination {
  id: number; enabled: boolean; pasTransfer: number; pusdTransfer: number;
  remoteFee: bigint; maxDeliveryFee: bigint; minPas: bigint; minPusd: bigint;
}
export interface TierConfig { enabled: boolean; pas: bigint; pusd: bigint; }
export interface Snapshot {
  epoch: bigint; nextEpochStart: bigint; paused: boolean; cap: number; used: number;
  pasBalance: bigint; pusdBalance: bigint; destinations: Destination[];
  lite: TierConfig; full: TierConfig;
}
export interface Receipt { txHash: string; destination: number; recipient: string; }
export interface FaucetService {
  address: string;
  refresh(): Promise<Snapshot>;
  claim(destination: number, recipient: Hex, progress: (message: string) => void): Promise<Receipt>;
  destroy(): void;
}

export function parseRecipient(value: string, destination: number): Hex {
  const input = value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    if (destination !== 1000) throw new Error('Ethereum addresses can receive tokens only on Asset Hub. Use a Substrate address for this chain.');
    return `${input.toLowerCase()}${'ee'.repeat(12)}` as Hex;
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) {
    if (destination !== 1000 && input.slice(-24).toLowerCase() === 'ee'.repeat(12)) {
      throw new Error('This is an Ethereum-derived account. Choose Asset Hub or use a Substrate address.');
    }
    return input.toLowerCase() as Hex;
  }
  try {
    const info = getSs58AddressInfo(input);
    if (info.isValid) {
      const result = bytesToHex(info.publicKey);
      if (destination !== 1000 && result.slice(-24).toLowerCase() === 'ee'.repeat(12)) {
        throw new Error('Ethereum-derived account');
      }
      return result;
    }
  } catch { /* Show the actionable address error below. */ }
  throw new Error('Enter a valid Substrate address. Asset Hub also accepts an Ethereum address.');
}

/** Runtime expects SCALE BoundedVec, while the host returns raw proof bytes. */
export function encodeProof(raw: Uint8Array): Hex {
  if (raw.length === 0 || raw.length > 1265) throw new Error('The host returned an invalid proof length.');
  const length = raw.length < 64 ? Uint8Array.of(raw.length << 2)
    : Uint8Array.of(((raw.length << 2) | 1) & 255, raw.length >> 6);
  return bytesToHex(new Uint8Array([...length, ...raw]));
}

export function formatAmount(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const integer = (value / divisor).toLocaleString('en-US');
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return integer + (fraction ? `.${fraction}` : '');
}

export function claimBlocker(state: Snapshot, destinationId: number, tier: TierConfig): string | null {
  if (state.paused) return 'The faucet is paused. Please try again later.';
  const d = state.destinations.find((entry) => entry.id === destinationId);
  if (!d || d.pasTransfer === 0) return 'This chain is not available from the faucet yet.';
  if (!d.enabled) return 'Claims to this chain are temporarily paused.';
  if (!tier.enabled) return 'Claims for this personhood tier are temporarily disabled.';
  if (state.used >= state.cap) return 'All claims for this period have been used. Try again next period.';
  if (tier.pas < d.minPas || (d.pusdTransfer !== 0 && tier.pusd < d.minPusd)) return 'This payout is below the destination’s minimum balance.';
  if (state.pasBalance < tier.pas + d.maxDeliveryFee || (d.pusdTransfer !== 0 && state.pusdBalance < tier.pusd)) return 'The faucet needs a refill. Please try again later.';
  return null;
}

export function bytesEqual(a: Uint8Array, hex: Hex): boolean {
  const b = hexToBytes(hex);
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
