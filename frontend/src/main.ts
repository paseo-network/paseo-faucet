import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-serif-display/400.css';
import './style.css';
import { ASSET_HUB, chainInfo, claimBlocker, formatAmount, isEthereumDerived, netPas, parseRecipient, planPayouts, type FaucetService, type Payout, type Receipt, type Snapshot, type SkipReason } from './model';
import type { Hex } from 'viem';

const contractAddress = import.meta.env.VITE_FAUCET_ADDRESS?.trim() || '';
const productId = import.meta.env.VITE_PRODUCT_ID || 'faucet.dot';
const configured = /^0x[0-9a-fA-F]{40}$/.test(contractAddress) && !/^0x0{40}$/.test(contractAddress);
let service: FaucetService | undefined;
let state: Snapshot | undefined;
let busy = false;
let destroyed = false;
let generation = 0;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="navigation-bar">
    <a class="brand" href="./" aria-label="Paseo faucet home"><img src="./polkadot.svg" alt="Polkadot" width="144" height="32"></a>
    <a class="questions-btn" href="#faq">→ Questions?</a>
  </header>
  <main>
    <section class="faucet-card" aria-labelledby="title">
      <div class="eyebrow"><span class="network-dot"></span> PASEO TESTNET</div>
      <h1 id="title">Testnet Faucet</h1>
      <p class="card-subtitle">Get PAS tokens for Polkadot’s Paseo testnet<br class="desktop-break"> and its parachains.</p>
      <div class="connection-row">
        <span class="connection-status"><span class="status-dot" id="connection-dot"></span><span id="connection-label">Not connected</span></span>
        <button id="connect" class="text-button" type="button">Connect Polkadot app <span aria-hidden="true">↗</span></button>
      </div>
      <form id="claim-form" novalidate>
        <div class="field-group"><label for="network">Network</label><div class="fixed-network" id="network"><span class="paseo-icon" aria-hidden="true">P</span> Paseo <span class="testnet-tag">Testnet</span></div></div>
        <div class="field-group address-group"><div class="label-row"><label for="address">Paseo address</label><button id="use-account" class="text-button" type="button" hidden>Use connected account</button></div>
          <input id="address" name="address" type="text" placeholder="Your Substrate address or 0x address" autocomplete="off" spellcheck="false" aria-describedby="address-help address-error">
          <p id="address-help" class="field-help">Where should we send your test tokens? The same account is paid on every chain.</p>
          <p id="address-error" class="field-error" hidden></p>
        </div>
        <div class="payout-summary"><div><span class="summary-label">You’ll receive</span><ul id="payout" class="payout-list"><li>— PAS</li></ul></div><span class="token-mark" aria-hidden="true">✳</span></div>
        <p id="payout-help" class="field-help">Amounts are set by the faucet for your personhood tier.</p>
        <div id="notice" class="notice" role="status" aria-live="polite"></div>
        <button class="submit-btn" id="claim" type="submit" disabled>Get some PAS</button>
        <p class="claim-note"><span aria-hidden="true">♧</span> One claim per person, tier and period pays every chain listed.</p>
      </form>
      <div id="success" class="success" role="status" hidden><div class="success-icon" aria-hidden="true">✓</div><h2 id="success-title">Claim confirmed</h2><p id="success-message"></p><ul id="success-list" class="payout-list"></ul><a id="transaction-link" target="_blank" rel="noopener noreferrer">View transaction ↗</a><button class="secondary-btn" id="back" type="button">Back to faucet</button></div>
      <div class="card-bottom"><span><span class="status-dot" id="faucet-dot"></span> <span id="faucet-status">Faucet status unavailable</span></span><button id="refresh" type="button" class="text-button" hidden>Refresh ↻</button></div>
    </section>
    <section class="how-it-works" aria-label="How to claim"><span><b>1</b> Connect your app</span><span class="step-divider" aria-hidden="true"></span><span><b>2</b> Enter your address</span><span class="step-divider" aria-hidden="true"></span><span><b>3</b> Get test tokens</span></section>
    <section id="faq" class="faq" aria-labelledby="faq-title"><span class="eyebrow">GOOD TO KNOW</span><h2 id="faq-title">Frequently asked questions</h2>
      <details><summary>What is Paseo?</summary><p>Paseo is Polkadot’s test network. Use PAS to try transactions, build applications and test integrations before using a production network. These are test tokens with no monetary value.</p></details>
      <details><summary>How do I get test tokens?</summary><p>Open this product in a supported Polkadot host and connect your app. Enter the recipient address and confirm the claim. The host provides a personhood proof and requests PGAS to cover transaction fees.</p></details>
      <details><summary>Why do I need proof of personhood?</summary><p>The faucet limits claims by personhood key instead of wallet address. It checks an anonymous membership proof on chain. Both People and People Lite are supported, with independently configured amounts and quotas.</p></details>
      <details><summary>Which chains are paid?</summary><p>One claim pays every chain the faucet owner has enabled, among Paseo Relay, Asset Hub, People, Bulletin, Asset Hub Next, Bulletin Next and People Next. pUSD is included where the chain supports it. A chain that cannot be paid at that moment is skipped, and you can claim it again later in the same period.</p></details>
      <details><summary>Can I claim without PAS?</summary><p>A supported host can provide PGAS for a product account’s contract transaction and storage deposit. Real zero-PAS claims still need to pass the faucet’s launch checks. Ethereum wallet transactions cannot use this PGAS path.</p></details>
    </section>
  </main>
  <footer><div><a href="https://github.com/r0gue-io/paseo-faucet" target="_blank" rel="noopener noreferrer">Source code ↗</a><a href="https://polkadot.com" target="_blank" rel="noopener noreferrer">Polkadot ↗</a></div></footer>
`;

function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const addressInput = el<HTMLInputElement>('address');
const claimButton = el<HTMLButtonElement>('claim');
const connectButton = el<HTMLButtonElement>('connect');
const form = el<HTMLFormElement>('claim-form');
function notice(message: string, kind = 'info') {
  el('notice').textContent = message;
  el('notice').className = `notice ${kind}`;
  el('notice').hidden = !message;
}
const SKIP_TEXT: Record<SkipReason, string> = {
  BelowMinimum: 'below this chain’s minimum',
  InsufficientPas: 'the faucet needs a refill',
  PayoutFailed: 'the transfer failed; claim again later this period',
};
function payoutText(payout: Payout): string {
  const pas = state ? netPas(payout, state.destinations) : payout.pas;
  const remote = payout.id !== ASSET_HUB ? 'at least ' : '';
  return `${chainInfo(payout.id).name}: ${remote}${formatAmount(pas, 10)} PAS${payout.pusd ? ` + ${formatAmount(payout.pusd, 6)} pUSD` : ''}`;
}
function fillList(list: HTMLElement, items: { text: string; href?: string }[]) {
  list.replaceChildren(...items.map(({ text, href }) => {
    const item = document.createElement('li');
    item.textContent = text;
    if (href) {
      const link = Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener noreferrer', textContent: ' Check arrival ↗' });
      item.append(link);
    }
    return item;
  }));
}
function validate(showError = false) {
  let valid = false;
  let error = '';
  let recipient: Hex | undefined;
  try { recipient = parseRecipient(addressInput.value); valid = true; }
  catch (e) { error = (e as Error).message; }
  const remote = state?.destinations.some(d => d.enabled && d.id !== ASSET_HUB) ?? true;
  if (recipient && remote && isEthereumDerived(recipient)) {
    error = 'Only Asset Hub can use an Ethereum address. What other chains receive for it cannot be spent; use a Substrate address to use them.';
  }
  el('address-error').hidden = !showError || !error;
  el('address-error').textContent = error;
  addressInput.setAttribute('aria-invalid', String(showError && !valid));
  const blocked = state && [state.full, state.lite].every(t => claimBlocker(state!, t) !== null);
  claimButton.disabled = busy || !valid || !service || !state || Boolean(blocked);
  return valid;
}
function render() {
  if (!state) {
    notice(configured ? 'Connect in a Polkadot host to check eligibility and request tokens.' : 'The new faucet is being prepared. Claims will open after the contract is deployed and funded.');
    return validate();
  }
  const tier = state.full.enabled ? state.full : state.lite;
  notice(claimBlocker(state, tier) ?? 'Your app will prove personhood before you confirm the claim.');
  const { paid, skipped } = planPayouts(state.destinations, state, tier);
  if (tier.enabled && paid.length) {
    fillList(el('payout'), [...paid.map(p => ({ text: payoutText(p) })), ...skipped.map(s => ({ text: `${chainInfo(s.id).name}: skipped, ${SKIP_TEXT[s.reason]}` }))]);
    el('payout-help').textContent = `${state.full.enabled ? 'Full' : 'Lite'} personhood amounts shown${state.full.enabled && state.lite.enabled ? '; lite persons receive the lite amounts' : ''}. Other chains deduct their execution fee from the PAS and return what it does not use.`;
  } else { fillList(el('payout'), [{ text: '— PAS' }]); el('payout-help').textContent = 'Payout information is unavailable.'; }
  const next = new Date(Number(state.nextEpochStart) * 1000);
  el('faucet-status').textContent = state.paused ? 'Faucet paused' : `${state.used.toLocaleString()} / ${state.cap.toLocaleString()} claims this period`;
  el('faucet-status').title = `Next period: ${next.toLocaleString()}`;
  el('faucet-dot').classList.toggle('online', !state.paused && state.used < state.cap);
  el('refresh').hidden = false;
  validate();
}
function setBusy(value: boolean) {
  busy = value;
  connectButton.disabled = value;
  addressInput.disabled = value;
  el<HTMLButtonElement>('refresh').disabled = value;
  el<HTMLButtonElement>('use-account').disabled = value;
  validate();
}

connectButton.addEventListener('click', async () => {
  if (busy) return;
  if (!configured) return notice('The faucet contract has not been deployed yet. Claims will open once setup is completed.');
  const run = ++generation;
  setBusy(true); notice('Connecting to your Polkadot app…');
  service?.destroy(); service = undefined; state = undefined;
  el('connection-label').textContent = 'Connecting…'; el('connection-dot').classList.remove('online');
  try {
    const { connectFaucet } = await import('./service');
    const connected = await connectFaucet(contractAddress as Hex, productId);
    if (destroyed || run !== generation) { connected.destroy(); return; }
    service = connected;
    state = await connected.refresh();
    el('connection-label').textContent = `${connected.address.slice(0, 6)}…${connected.address.slice(-6)}`;
    el('connection-dot').classList.add('online'); connectButton.textContent = 'Reconnect ↗';
    el('use-account').hidden = false;
    if (!addressInput.value) addressInput.value = connected.address;
    render();
  } catch (error) {
    service?.destroy(); service = undefined; state = undefined;
    el('connection-label').textContent = 'Not connected'; notice((error as Error).message, 'error');
  } finally { if (!destroyed && run === generation) setBusy(false); }
});
addressInput.addEventListener('input', () => validate(Boolean(addressInput.value)));
addressInput.addEventListener('blur', () => validate(Boolean(addressInput.value)));
el('use-account').addEventListener('click', () => { if (service) { addressInput.value = service.address; validate(true); } });
el('refresh').addEventListener('click', async () => {
  if (!service || busy) return;
  setBusy(true);
  try { state = await service.refresh(); render(); } catch (e) { notice((e as Error).message, 'error'); }
  finally { setBusy(false); }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !service || !validate(true)) return;
  const recipient = parseRecipient(addressInput.value);
  setBusy(true);
  try {
    const receipt = await service.claim(recipient, message => { notice(`${message}…`); claimButton.textContent = message.startsWith('Confirm ') ? 'Confirm in your Polkadot app' : message; });
    form.hidden = true; el('success').hidden = false;
    showReceipt(receipt);
    try { state = await service.refresh(); } catch { /* Keep the successful receipt visible if refresh fails. */ }
  } catch (error) { notice((error as Error).message, 'error'); }
  finally { claimButton.textContent = 'Get some PAS'; setBusy(false); }
});
function showReceipt(receipt: Receipt) {
  const remote = receipt.paid.some(p => p.id !== ASSET_HUB);
  el('success-title').textContent = remote ? 'Transfers dispatched' : 'Your tokens are on their way';
  el('success-message').textContent = `Your claim is finalized on Asset Hub.${remote ? ' Other chains receive their transfer asynchronously.' : ''}${receipt.skipped.length ? ' Skipped chains can be claimed again later this period.' : ''}`;
  fillList(el('success-list'), [
    ...receipt.paid.map(p => ({ text: payoutText(p), href: p.id !== ASSET_HUB ? chainInfo(p.id).explorer : undefined })),
    ...receipt.skipped.map(s => ({ text: `${chainInfo(s.id).name}: skipped, ${SKIP_TEXT[s.reason]}` })),
  ]);
  el<HTMLAnchorElement>('transaction-link').href = `https://assethub-paseo.subscan.io/extrinsic/${encodeURIComponent(receipt.txHash)}`;
}
el('back').addEventListener('click', () => { el('success').hidden = true; form.hidden = false; render(); });
addressInput.value = new URLSearchParams(location.search).get('address') || '';
window.addEventListener('pagehide', () => { destroyed = true; ++generation; service?.destroy(); });
render();
