import { test, expect } from '@playwright/test';

test('homepage runs real Python examples, validates input, completes and accepts stdin', async ({ page }) => {
  const errors: string[] = [];
  const downloads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('cdn.jsdelivr.net/pyodide')) downloads.push(request.url()); });
  await page.goto('./');
  await expect(page.getByRole('heading', {name:'Real scripts. Right here.'})).toBeVisible();
  expect(downloads).toHaveLength(0); // Runtime only loads on explicit Start.
  await page.getByRole('button', {name:'Start Python playground'}).click();
  await expect(page.locator('#playground-status')).toContainText('Ready ·', {timeout:90_000});
  const command = page.getByRole('textbox', {name:'Playground command'});
  const output = page.getByLabel('Playground terminal output');
  await page.getByRole('button', {name:'Generated help', exact:true}).click();
  await expect(output).toContainText('--replicas');
  await expect(command).toBeEnabled();
  await command.fill('plan.py --en'); await command.press('Tab');
  await expect(command).toHaveValue('plan.py --env ');
  await command.fill('plan.py --env pr'); await command.press('Tab');
  await expect(command).toHaveValue('plan.py --env production ');
  await command.press('Enter');
  await expect(output).toContainText('"env": "production"');
  await expect(command).toBeEnabled();
  await command.press('ArrowUp'); await expect(command).toHaveValue('plan.py --env production ');
  await page.getByRole('button', {name:'Try validation'}).click();
  await expect(output).toContainText('exit 1');
  await page.getByRole('button', {name:'Read a CSV'}).click();
  await expect(output).toContainText('160.00');
  await expect(command).toBeEnabled();
  await page.locator('.playground-stdin summary').click();
  await page.getByRole('textbox', {name:'Input document'}).fill('{"z":2,"a":1}');
  await command.fill('json-format.py --style compact --sort'); await command.press('Enter');
  await expect(output).toContainText('{"a":1,"z":2}');
  await expect(command).toBeEnabled();
  await command.fill('cat examples/scripts/plan.py'); await command.press('Enter');
  await expect(output).toContainText('cli.set_description');
  await expect(command).toBeEnabled();
  await command.fill('clear'); await command.press('Enter'); await expect(output).toHaveText('');
  await page.getByRole('button', {name:'Reset', exact:true}).click();
  await expect(command).toBeDisabled();
  await expect(page.getByRole('button', {name:'Start Python playground'})).toBeEnabled();
  expect(errors).toEqual([]);
});

test('mobile layout and documentation routes retain the site prefix', async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('./');
  await page.locator('#playground').scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', {name:'Copy the full setup'}).click();
  await expect(page.getByRole('heading', {name:'Bash, Zsh and Fish completion', exact:true})).toBeVisible();
  await expect(page.getByRole('heading', {name:'Zsh', exact:true})).toBeVisible();
  await page.getByRole('navigation', {name:'Documentation'}).getByRole('link', {name:'Clone-and-run examples'}).click();
  await expect(page.getByRole('heading', {name:'Clone-and-run example tools', exact:true})).toBeVisible();
});

test('runtime load failure offers a retry and the local examples', async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/pyodide/**', route => route.abort());
  await page.goto('./'); await page.getByRole('button', {name:'Start Python playground'}).click();
  await expect(page.locator('#playground-status')).toContainText('Could not load Python');
  await expect(page.getByRole('button', {name:'Start Python playground'})).toBeEnabled();
  await expect(page.getByRole('link', {name:'Get the whole scripts directory'})).toBeVisible();
});
