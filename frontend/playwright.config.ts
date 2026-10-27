import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: [
    { command: 'npm run dev -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
    // A deployed faucet's page, for the tests that script the host behind it.
    { command: 'npm run dev -- --port 4174 --strictPort', url: 'http://127.0.0.1:4174', reuseExistingServer: !process.env.CI,
      env: { VITE_FAUCET_ADDRESS: '0x1234567890123456789012345678901234567890' } },
  ],
});
