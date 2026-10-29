import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-serif-display/400.css';
import './style.css';
import { ASSET_HUB, chainInfo, claimBlocker, formatAmount, isEthereumDerived, netPas, parseRecipient, planPayouts, type FaucetHost, type FaucetService, type Payout, type Receipt, type Snapshot, type SkipReason, type TierConfig } from './model';
import type { Hex } from 'viem';

const contractAddress = import.meta.env.VITE_FAUCET_ADDRESS?.trim() || '';
const productId = import.meta.env.VITE_PRODUCT_ID || 'faucet.dot';
const configured = /^0x[0-9a-fA-F]{40}$/.test(contractAddress) && !/^0x0{40}$/.test(contractAddress);
const SIGNED_OUT = { text: 'Connect your Polkadot app to check eligibility and claim.' };
let host: FaucetHost | undefined;
let service: FaucetService | undefined;
let state: Snapshot | undefined;
let busy = false;
let destroyed = false;
/** Whether the page runs in a Polkadot host, where the person can sign in. */
let canSignIn = false;
/** What the notice says while no account is connected. */
let idle: { text: string; kind?: string } = configured ? { text: '' } : { text: 'The new faucet is being prepared. Claims will open after the contract is deployed and funded.' };
let connecting: Promise<void> | undefined;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="navigation-bar">
    <a class="brand" href="./" aria-label="Paseo faucet home"><img src="./polkadot.svg" alt="Polkadot" width="144" height="32"></a>
    <a class="questions-btn" href="#faq">→ Questions?</a>
  </header>
  <main>
    <section class="faucet-card" aria-labelledby="title">
      <div class="eyebrow"><span class="network-dot"></span> PASEO TESTNET</div>
      <h1 id="title">Testnet Faucet</h1>
      <section class="how-it-works" aria-label="How to claim"><span><b>1</b> Connect your app</span><span class="step-divider" aria-hidden="true"></span><span><b>2</b> Enter your address</span><span class="step-divider" aria-hidden="true"></span><span><b>3</b> Get test tokens</span></section>
      <div class="connection-row">
        <span class="connection-status"><span class="status-dot" id="connection-dot"></span><button id="connection-label" class="address-copy" type="button" disabled>Not connected</button></span>
        <button id="connect" class="text-button" type="button" hidden>Connect Polkadot app <span aria-hidden="true">↗</span></button>
      </div>
      <form id="claim-form" novalidate>
        <div class="field-group address-group"><div class="label-row"><label for="address">Beneficiary</label><button id="use-account" class="text-button" type="button" hidden>Use connected account</button></div>
          <input id="address" name="address" type="text" placeholder="Your Substrate address or 0x address" autocomplete="off" spellcheck="false" aria-describedby="address-help address-error">
          <p id="address-help" class="field-help">Where should the tokens be sent? The same account is paid on every chain.</p>
          <p id="address-error" class="field-error" hidden></p>
        </div>
        <div id="payout-summary" class="payout-summary" hidden><div><span class="summary-label">You’ll receive</span><ul id="payout" class="payout-list"></ul></div></div>
        <p id="payout-help" class="field-help" hidden></p>
        <div id="notice" class="notice" role="status" aria-live="polite"></div>
        <button class="submit-btn" id="claim" type="submit" disabled>Get some PAS</button>
        <p class="claim-note"><span aria-hidden="true">♧</span> One claim per person, tier and period pays every chain listed.</p>
      </form>
      <div id="success" class="success" role="status" hidden><div class="success-icon" aria-hidden="true">✓</div><h2 id="success-title">Claim confirmed</h2><p id="success-message"></p><ul id="success-list" class="payout-list"></ul><a id="transaction-link" target="_blank" rel="noopener noreferrer">View transaction ↗</a><button class="secondary-btn" id="back" type="button">Back to faucet</button></div>
      <div class="card-bottom"><span><span class="status-dot" id="faucet-dot"></span> <span id="faucet-status">Faucet status unavailable</span></span><button id="refresh" type="button" class="text-button" hidden>Refresh ↻</button></div>
    </section>
    <section id="faq" class="faq" aria-labelledby="faq-title"><h2 id="faq-title">Frequently asked questions</h2>
      <details><summary>What is Paseo?</summary><p>Paseo is Polkadot’s test network. Use PAS to try transactions, build applications and test integrations before using a production network. These are test tokens with no monetary value.</p></details>
      <details><summary>How do I get test tokens?</summary><p>Open this product in a supported Polkadot host and connect your app. Enter the recipient address and confirm the claim. The host provides a personhood proof and requests PGAS to cover transaction fees.</p></details>
      <details><summary>Why do I need proof of personhood?</summary><p>The faucet limits claims by person instead of wallet address. It checks an anonymous membership proof on chain. Full persons (People) and lite persons (People Lite) receive their own amounts. Each person can claim once per tier and period.</p><div class="faq-table"><table><thead><tr><th></th><th>Full person</th><th>Lite person</th></tr></thead><tbody><tr><th>PAS per chain</th><td>5,000</td><td>500</td></tr><tr><th>pUSD per chain (if supported)</th><td>500</td><td>100</td></tr><tr><th>Claims</th><td>Once per 24 h</td><td>Once per 24 h</td></tr></tbody></table><p>Other chains deduct their execution fee from the PAS.</p></div></details>
      <details><summary>Which chains are paid?</summary><p>One claim pays every chain below. pUSD is included where the chain supports it. A chain that cannot be paid at that moment is skipped, and you can claim it again later in the same period.</p><div class="faq-table"><table><thead><tr><th>Chain</th><th>PAS</th><th>pUSD</th></tr></thead><tbody><tr><th>Asset Hub</th><td>✓</td><td>✓</td></tr><tr><th>People</th><td>✓</td><td>✓</td></tr><tr><th>Bulletin</th><td>✓</td><td>—</td></tr><tr><th>Asset Hub Next</th><td>✓</td><td>—</td></tr><tr><th>People Next</th><td>✓</td><td>—</td></tr><tr><th>Bulletin Next</th><td>✓</td><td>—</td></tr></tbody></table></div></details>
      <details><summary>Can I claim without PAS?</summary><p>A supported host can provide PGAS for a product account’s contract transaction and storage deposit. Real zero-PAS claims still need to pass the faucet’s launch checks. Ethereum wallet transactions cannot use this PGAS path.</p></details>
    </section>
  </main>
  <footer><div><a href="https://github.com/paseo-network/paseo-faucet" target="_blank" rel="noopener noreferrer">Source code ↗</a><a href="https://polkadot.com" target="_blank" rel="noopener noreferrer">Polkadot ↗</a></div></footer>
`;

function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const addressInput = el<HTMLInputElement>('address');
const claimButton = el<HTMLButtonElement>('claim');
const connectButton = el<HTMLButtonElement>('connect');
const accountButton = el<HTMLButtonElement>('connection-label');
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
  el('payout-summary').hidden = el('payout-help').hidden = !state || !el('payout').childElementCount;
  const tier = personTier();
  const blocked = state && (!tier || claimBlocker(state, tier) !== null);
  claimButton.disabled = busy || !valid || !service || !state || Boolean(blocked);
  return valid;
}
/** The tier a claim would use: the first the person holds a key for that is open, full before lite. */
function personTier(): TierConfig | undefined {
  if (!state || !service) return undefined;
  const config: Record<number, TierConfig> = { 2: state.full, 1: state.lite };
  return service.heldTiers.map(t => config[t]).find(t => t.enabled);
}
/** The faucet's claims this period, or that it is paused, in the footer. */
function showStatus() {
  if (!state) return;
  const next = new Date(Number(state.nextEpochStart) * 1000);
  el('faucet-status').textContent = state.paused ? 'Faucet paused' : `${state.used.toLocaleString()} / ${state.cap.toLocaleString()} claims this period`;
  el('faucet-status').title = `Next period: ${next.toLocaleString()}`;
  el('faucet-dot').classList.toggle('online', !state.paused && state.used < state.cap);
  el('refresh').hidden = false;
}
function render() {
  showStatus();
  if (!state || !service) {
    notice(idle.text, idle.kind);
    fillList(el('payout'), []);
    return validate();
  }
  const tier = personTier();
  const noKey = service.notMemberTiers.length
    ? 'Your personhood is not active in a People ring yet, so the faucet cannot verify it. Try again later.'
    : 'Your Polkadot app has no People or People Lite key this faucet can use.';
  if (!service.heldTiers.length) notice(noKey);
  else notice(tier ? claimBlocker(state, tier) ?? '' : 'Claims for your personhood tier are temporarily disabled.');
  const { paid, skipped } = tier ? planPayouts(state.destinations, state, tier) : { paid: [], skipped: [] };
  fillList(el('payout'), paid.length ? [...paid.map(p => ({ text: payoutText(p) })), ...skipped.map(s => ({ text: `${chainInfo(s.id).name}: skipped, ${SKIP_TEXT[s.reason]}` }))] : []);
  // Unless the host confirmed the membership, a key held for the full ring may not be a member of it; the claim then
  // falls back to the lite tier.
  const fallback = tier === state.full && !service.memberConfirmed && service.heldTiers.includes(1) && state.lite.enabled
    ? ` If your full personhood is not active yet, you get the lite amounts instead: ${formatAmount(state.lite.pas, 10)} PAS per chain${state.lite.pusd ? `, plus ${formatAmount(state.lite.pusd, 6)} pUSD where supported` : ''}.`
    : '';
  const waiting = tier === state.lite && service.notMemberTiers.includes(2) ? ' Your full personhood is not active in the People ring yet.' : '';
  el('payout-help').textContent = `For a ${tier === state.full ? 'full' : 'lite'} person.${waiting}${fallback}${paid.some(p => p.id !== ASSET_HUB) ? ' Other chains deduct their execution fee from the PAS and return what it does not use.' : ''}`;
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

/** Opens the faucet through the host, read-only, and connects whoever is signed in to it without a click. */
async function start() {
  setBusy(true); showAccount('Connecting…');
  try {
    const { openFaucet } = await import('./service');
    const opened = await openFaucet(contractAddress as Hex, productId);
    if (destroyed) return opened?.destroy();
    canSignIn = Boolean(opened);
    if (!opened) { idle = { text: 'Open this faucet inside a Polkadot host to connect your app and prove personhood.' }; return; }
    host = opened;
    state = await opened.refresh();
    opened.onSignInChange((signedIn) => {
      if (signedIn && !service) void connectAccount();
      if (!signedIn && service) { service.destroy(); service = undefined; idle = SIGNED_OUT; showConnection(); render(); }
    });
    await connectAccount();
  } catch (error) {
    host?.destroy(); host = undefined; state = undefined;
    canSignIn = true;
    idle = { text: (error as Error).message, kind: 'error' };
  } finally { if (!destroyed) { setBusy(false); showConnection(); render(); } }
}
/** Connects the signed-in person's account; while nobody is signed in, the page stays read-only. */
function connectAccount(): Promise<void> {
  connecting ??= (async () => {
    try {
      const connected = await host?.connect();
      if (destroyed || !host) return connected?.destroy();
      if (!connected) { idle = SIGNED_OUT; return; }
      service?.destroy(); service = connected;
      if (!addressInput.value) addressInput.value = connected.address;
    } catch (error) {
      idle = { text: (error as Error).message, kind: 'error' };
    } finally { connecting = undefined; if (!destroyed) { showConnection(); render(); } }
  })();
  return connecting;
}
// Signed out, the button opens the host's sign-in, such as the code that pairs the Polkadot app.
connectButton.addEventListener('click', async () => {
  if (busy) return;
  if (!host) return start();
  setBusy(true); notice('Complete the sign-in in the Polkadot host.');
  try {
    if (await host.signIn()) await connectAccount();
    else idle = SIGNED_OUT;
  } catch (error) {
    idle = { text: (error as Error).message, kind: 'error' };
  } finally { if (!destroyed) { setBusy(false); showConnection(); render(); } }
});
/** The connection row: the account once connected; otherwise, in a host, the button to sign in. */
function showConnection() {
  const address = service?.address;
  showAccount(address ? `${address.slice(0, 6)}…${address.slice(-6)}` : 'Not connected', address);
  el('connection-dot').classList.toggle('online', Boolean(service));
  connectButton.hidden = !canSignIn || Boolean(service);
  el('use-account').hidden = !service;
}
/** Shows the connection state; with an address, the label is a button that copies it. */
function showAccount(text: string, address?: string) {
  accountButton.textContent = text;
  accountButton.disabled = !address;
  accountButton.title = address ? 'Copy the full address' : '';
}
accountButton.addEventListener('click', async () => {
  if (!service) return;
  const { address } = service;
  const shown = accountButton.textContent;
  try {
    await navigator.clipboard.writeText(address);
  } catch {
    return notice(`Copying is not available here. Your address is ${address}`);
  }
  accountButton.textContent = 'Copied';
  setTimeout(() => { if (service?.address === address) accountButton.textContent = shown; }, 1500);
});
addressInput.addEventListener('input', () => validate(Boolean(addressInput.value)));
addressInput.addEventListener('blur', () => validate(Boolean(addressInput.value)));
el('use-account').addEventListener('click', () => { if (service) { addressInput.value = service.address; validate(true); } });
el('refresh').addEventListener('click', async () => {
  if (!host || busy) return;
  setBusy(true);
  try { state = await host.refresh(); render(); } catch (e) { notice((e as Error).message, 'error'); }
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
    try { if (host) { state = await host.refresh(); showStatus(); } } catch { /* Keep the successful receipt visible if refresh fails. */ }
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
window.addEventListener('pagehide', () => { destroyed = true; service?.destroy(); host?.destroy(); });
render();
if (configured) void start();
