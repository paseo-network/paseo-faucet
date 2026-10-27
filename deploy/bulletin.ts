import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, parseSuri, ss58Address } from '@polkadot-labs/hdkd-helpers';
import { createClient, Enum, type PolkadotClient } from 'polkadot-api';
import { getTxCreator } from 'polkadot-api/tx-creator';
import { getWsProvider } from 'polkadot-api/ws';
import type { Block } from './lib.ts';

export type Signer = ReturnType<typeof getTxCreator>;

function sr25519Account(phrase: string, path: string, password?: string): { signer: Signer; address: string } {
  const pair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(phrase), password))(path);
  return { signer: getTxCreator(pair.publicKey, 'Sr25519', pair.sign), address: ss58Address(pair.publicKey) };
}

/** The sr25519 root account of `mnemonic`, the account polkadot-app-deploy stores with. */
export function signerFromMnemonic(mnemonic: string): { signer: Signer; address: string } {
  return sr25519Account(mnemonic, '');
}

/** The sr25519 account of a key URI, `<mnemonic>//hard/soft///password`; a URI that starts with a path, such as `//Eve`, derives from the development phrase. */
export function signerFromUri(uri: string): { signer: Signer; address: string } {
  const { phrase, paths, password } = parseSuri(uri.startsWith('/') ? `${DEV_PHRASE}${uri}` : uri);
  if (!phrase) throw new Error('the key URI is not a mnemonic with an optional derivation path');
  return sr25519Account(phrase, paths ?? '', password);
}

interface AuthorizationEntry {
  expiration: number;
  extent: { transactions: number; transactions_allowance: number; bytes: bigint; bytes_allowance: bigint };
}

export interface Authorization {
  expiration: number;
  transactions: number;
  transactionsAllowance: number;
  bytes: bigint;
  bytesAllowance: bigint;
}

/** A connection to Bulletin's TransactionStorage, reading at the finalized block. */
export class Bulletin {
  private constructor(
    private readonly client: PolkadotClient,
    private readonly api: ReturnType<PolkadotClient['getUnsafeApi']>,
  ) {}

  static connect(endpoints: readonly string[]): Bulletin {
    const client = createClient(getWsProvider([...endpoints]));
    return new Bulletin(client, client.getUnsafeApi());
  }

  async genesis(): Promise<string> {
    return (await this.client.getChainSpecData()).genesisHash;
  }

  async head(): Promise<number> {
    return (await this.client.getFinalizedBlock()).number;
  }

  async retention(): Promise<number> {
    return Number(await this.api.query.TransactionStorage.RetentionPeriod.getValue());
  }

  /** The average block time over the `span` blocks before `head`, from their timestamps. */
  async blockTimeMs(head: number, span = 100): Promise<number> {
    const [end, start] = await Promise.all(
      [head, head - span].map(async (n) => {
        const hash = await this.client._request<string, [number]>('chain_getBlockHash', [n]);
        return Number(await this.api.query.Timestamp.Now.getValue({ at: hash }));
      }),
    );
    return (end - start) / span;
  }

  /** The block each block was last stored at, or undefined where Bulletin no longer holds it. */
  async storedAt(blocks: Block[]): Promise<(number | undefined)[]> {
    const keys = blocks.map((block) => [`0x${Buffer.from(block.cid.multihash.digest).toString('hex')}`]);
    const entries = (await this.api.query.TransactionStorage.TransactionByContentHash.getValues(keys)) as ([number, number] | undefined)[];
    return entries.map((entry) => (entry === undefined ? undefined : Number(entry[0])));
  }

  async authorization(address: string): Promise<Authorization | undefined> {
    const entry = (await this.api.query.TransactionStorage.Authorizations.getValue(Enum('Account', address))) as AuthorizationEntry | undefined;
    if (!entry) return undefined;
    return {
      expiration: Number(entry.expiration),
      transactions: Number(entry.extent.transactions),
      transactionsAllowance: Number(entry.extent.transactions_allowance),
      bytes: BigInt(entry.extent.bytes),
      bytesAllowance: BigInt(entry.extent.bytes_allowance),
    };
  }

  /** How many blocks an authorization lasts once granted or extended. */
  async authorizationPeriod(): Promise<number> {
    return Number(await this.api.constants.TransactionStorage.AuthorizationPeriod());
  }

  async isAuthorizer(address: string): Promise<boolean> {
    return (await this.api.query.TransactionStorage.AllowedAuthorizers.getValue(address)) !== undefined;
  }

  /** Grants `who` an authorization for AuthorizationPeriod blocks, signed by an authorizer. */
  async authorize(who: string, transactions: number, bytes: bigint, signer: Signer): Promise<void> {
    await this.submit(this.api.tx.TransactionStorage.authorize_account({ who, transactions, bytes }), signer, `authorizing ${who}`);
  }

  /** Ends `who`'s authorization AuthorizationPeriod blocks from now, its allowance unchanged, signed by an authorizer. */
  async refresh(who: string, signer: Signer): Promise<void> {
    await this.submit(this.api.tx.TransactionStorage.refresh_account_authorization({ who }), signer, `extending ${who}'s authorization`);
  }

  /** Stores `block` under its CID's codec and SHA-256, as polkadot-app-deploy does, and waits for finality. */
  async store(block: Block, signer: Signer): Promise<void> {
    const tx = this.api.tx.TransactionStorage.store_with_cid_config({
      cid: { codec: BigInt(block.cid.code), hashing: Enum('Sha2_256') },
      data: block.bytes,
    });
    await this.submit(tx, signer, `storing ${block.cid}`);
  }

  private async submit(tx: { createAndSubmit(signer: Signer): Promise<{ ok: boolean; dispatchError?: unknown }> }, signer: Signer, what: string): Promise<void> {
    const result = await tx.createAndSubmit(signer);
    if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.dispatchError)}`);
  }

  destroy(): void {
    this.client.destroy();
  }
}
