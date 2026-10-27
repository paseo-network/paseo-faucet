import { expect, test } from '@playwright/test';

test('Paseo-only landing page has no chain picker and an honest setup state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Testnet Faucet', exact: true })).toBeVisible();
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('#payout-summary')).toBeHidden();
  await expect(page.locator('#claim')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('contract is deployed');
  await page.getByRole('button', { name: 'Connect Polkadot app' }).click();
  await expect(page.locator('#notice')).toContainText('not been deployed');
  await expect(page.locator('#connection-label')).toHaveText('Not connected');
  await expect(page.locator('#connection-label')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('an Ethereum recipient is warned that only Asset Hub can use it, an invalid one is refused', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Beneficiary').fill('0x1234567890123456789012345678901234567890');
  await expect(page.locator('#address-error')).toContainText('Only Asset Hub');
  await page.getByLabel('Beneficiary').fill('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
  await expect(page.locator('#address-error')).toBeHidden();
  await page.getByLabel('Beneficiary').fill('not-an-address');
  await expect(page.locator('#address-error')).toContainText('valid Substrate');
  await expect(page.locator('#claim')).toBeDisabled();
});

test('the address query parameter prefills the recipient; a chain parameter is ignored', async ({ page }) => {
  await page.goto('/?parachain=1004&address=test-address');
  await expect(page.getByLabel('Beneficiary')).toHaveValue('test-address');
  await expect(page.locator('select')).toHaveCount(0);
});

test('the FAQ tables show the faucet configuration without connecting', async ({ page }) => {
  await page.goto('/');
  for (const question of ['Why do I need proof of personhood?', 'Which chains are paid?']) {
    await page.getByText(question, { exact: true }).click();
  }
  await expect(page.locator('.faq-table table')).toHaveCount(2);
  await expect(page.locator('.faq-table').nth(0).locator('tbody td')).toHaveText(['5,000', '500', '500', '100', 'Once per 24 h', 'Once per 24 h']);
  await expect(page.locator('.faq-table').nth(1).locator('tbody th')).toHaveText(['Asset Hub', 'People', 'Bulletin', 'Asset Hub Next', 'People Next', 'Bulletin Next']);
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
