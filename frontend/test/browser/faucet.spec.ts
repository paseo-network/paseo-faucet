import { expect, test } from '@playwright/test';

test('Paseo-only landing page has no chain picker and an honest setup state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Testnet Faucet', exact: true })).toBeVisible();
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('#payout')).toHaveText('— PAS');
  await expect(page.locator('#claim')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('contract is deployed');
  await page.getByRole('button', { name: 'Connect Polkadot app' }).click();
  await expect(page.locator('#notice')).toContainText('not been deployed');
  await expect(page.locator('#connection-label')).toHaveText('Not connected');
  expect(errors).toEqual([]);
});

test('an Ethereum recipient is warned that only Asset Hub can use it, an invalid one is refused', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Paseo address').fill('0x1234567890123456789012345678901234567890');
  await expect(page.locator('#address-error')).toContainText('Only Asset Hub');
  await page.getByLabel('Paseo address').fill('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
  await expect(page.locator('#address-error')).toBeHidden();
  await page.getByLabel('Paseo address').fill('not-an-address');
  await expect(page.locator('#address-error')).toContainText('valid Substrate');
  await expect(page.locator('#claim')).toBeDisabled();
});

test('the address query parameter prefills the recipient; a chain parameter is ignored', async ({ page }) => {
  await page.goto('/?parachain=1004&address=test-address');
  await expect(page.getByLabel('Paseo address')).toHaveValue('test-address');
  await expect(page.locator('select')).toHaveCount(0);
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
