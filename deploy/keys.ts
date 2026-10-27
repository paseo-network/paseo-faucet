import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, parseSuri, ss58Address } from '@polkadot-labs/hdkd-helpers';
import { getTxCreator } from 'polkadot-api/tx-creator';

export type Signer = ReturnType<typeof getTxCreator>;

function sr25519Account(phrase: string, path: string, password?: string): { signer: Signer; address: string } {
  const pair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(phrase), password))(path);
  return { signer: getTxCreator(pair.publicKey, 'Sr25519', pair.sign), address: ss58Address(pair.publicKey) };
}

/** The sr25519 root account of `mnemonic`, the account polkadot-app-deploy signs with. */
export function signerFromMnemonic(mnemonic: string): { signer: Signer; address: string } {
  return sr25519Account(mnemonic, '');
}

/** The sr25519 account of a key URI, `<mnemonic>//hard/soft///password`; a URI that starts with a path, such as `//Eve`, derives from the development phrase. */
export function signerFromUri(uri: string): { signer: Signer; address: string } {
  const { phrase, paths, password } = parseSuri(uri.startsWith('/') ? `${DEV_PHRASE}${uri}` : uri);
  if (!phrase) throw new Error('the key URI is not a mnemonic with an optional derivation path');
  return sr25519Account(phrase, paths ?? '', password);
}

/** The operator account: the sr25519 root account of MNEMONIC. */
export function operator(): { signer: Signer; address: string } {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) throw new Error('MNEMONIC is not set');
  return signerFromMnemonic(mnemonic);
}
