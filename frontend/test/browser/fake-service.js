// Stands in for src/service.ts in the browser tests: a Polkadot host scripted by `window.fakeHost`.
const scenario = window.fakeHost;
const snapshot = {
  epoch: 20000n, nextEpochStart: 1728086400n, paused: false, cap: 1000, used: 10,
  pasBalance: 10n ** 18n, pusdBalance: 10n ** 12n,
  destinations: [{ id: 1000, enabled: true, pasTransfer: 1, pusdTransfer: 1, remoteFee: 0n, maxDeliveryFee: 0n, minPas: 100000000n, minPusd: 10n }],
  lite: { enabled: true, pas: 5000000000000n, pusd: 100000000n },
  full: { enabled: true, pas: 50000000000000n, pusd: 500000000n },
};
const account = { address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', heldTiers: [2, 1], destroy() {} };
const listeners = new Set();
const announce = (signedIn) => { scenario.signedIn = signedIn; for (const listener of listeners) listener(signedIn); };
window.fakeSignOut = () => announce(false);

export async function openFaucet() {
  if (!scenario.inside) return null;
  return {
    refresh: async () => snapshot,
    connect: async () => (scenario.signedIn ? account : null),
    async signIn() {
      scenario.logins = (scenario.logins ?? 0) + 1;
      if (scenario.login === 'Rejected') return false;
      announce(true);
      return true;
    },
    onSignInChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    destroy() {},
  };
}
