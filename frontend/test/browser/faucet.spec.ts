import { expect, test } from '@playwright/test';

test('Paseo-only landing page has exactly the requested chain choices and honest setup state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Testnet Faucet', exact: true })).toBeVisible();
  await expect(page.locator('#chain option')).toHaveText(['Paseo Relay', 'Asset Hub', 'People', 'Bulletin', 'Asset Hub Next', 'Bulletin Next', 'People Next']);
  await expect(page.locator('#claim')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('contract is deployed');
  await page.getByRole('button', { name: 'Connect Polkadot app' }).click();
  await expect(page.locator('#notice')).toContainText('not been deployed');
  await expect(page.locator('#connection-label')).toHaveText('Not connected');
  expect(errors).toEqual([]);
});

test('address errors update when the destination changes', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Paseo address').fill('0x1234567890123456789012345678901234567890');
  await expect(page.locator('#address-error')).toBeHidden();
  await page.getByLabel('Chain', { exact: true }).selectOption('1004');
  await expect(page.locator('#address-error')).toContainText('only on Asset Hub');
  await page.getByLabel('Paseo address').fill('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
  await expect(page.locator('#address-error')).toBeHidden();
  await expect(page.locator('#claim')).toBeDisabled();
});

test('query parameters support deep links without adding other networks', async ({ page }) => {
  for (const bulletin of ['1010', '1501']) {
    await page.goto(`/?parachain=${bulletin}`);
    await expect(page.getByLabel('Chain', { exact: true })).toHaveValue(bulletin);
  }
  await page.goto('/?parachain=1502&address=test-address');
  await expect(page.getByLabel('Chain', { exact: true })).toHaveValue('1502');
  await expect(page.getByLabel('Paseo address')).toHaveValue('test-address');
  await page.goto('/?parachain=1002');
  await expect(page.getByLabel('Chain', { exact: true })).toHaveValue('1000');
});

test('mobile layout is accessible and does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByText('What is Paseo?', { exact: true }).click();
  await expect(page.getByText(/Paseo is Polkadot’s test network/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/paseo-mobile.png', fullPage: true });
});

test('desktop layout and local assets render without backend or remote font requests', async ({ page }) => {
  const unexpected: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('data:')) unexpected.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await expect(page.getByRole('img', { name: 'Polkadot', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/paseo-desktop.png', fullPage: true });
  expect(unexpected).toEqual([]);
});
