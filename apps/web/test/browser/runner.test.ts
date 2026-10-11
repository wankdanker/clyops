import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function connect(page: Page) {
  await page.goto('/ui/');
  await page.locator('#api-key').fill('browser-key');
  await page.getByRole('button', { name: 'Connect to API' }).click();
  await expect(page.locator('.connection-status')).toHaveText('Connected');
}
async function choose(page: Page, name: string) { await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name, exact: false }).click(); }
async function override(page: Page, key: string, value: string) {
  const field=page.locator(`[data-field="${key}"]`); await field.getByRole('checkbox').check();
  const input=field.locator('input:not([type=checkbox]):not([type=file]), select').first();
  if(await input.evaluate(element=>element.tagName==='SELECT')) await input.selectOption(value); else await input.fill(value);
}

test('typed controls, inherited defaults, oneOf/exclusive, templates, JSON and real execution', async ({ page }) => {
  await connect(page); await choose(page,'plan');
  await expect(page.locator('[data-field=mode] select')).toBeDisabled();
  await override(page,'mode','slow'); await override(page,'count','0');
  await expect(page.locator('#field-count')).toHaveAttribute('min','0');
  await expect(page.locator('#field-count')).toHaveAttribute('max','10');
  await expect(page.locator('#field-count')).toHaveAttribute('step','1');
  await override(page,'count','99'); await expect(page.getByRole('button',{name:'Run tool',exact:false})).toBeDisabled();
  await page.locator('#field-count').fill('0');
  await page.locator('#field-dry_run').selectOption('false');
  await override(page,'key','never-persist-this'); await override(page,'email','ops@example.com');
  await override(page,'webhook','https://example.com');
  await expect(page.getByText('cannot be used together.', { exact: false })).toBeVisible();
  await page.locator('[data-field=webhook]').getByRole('checkbox').uncheck();
  await page.locator('[data-field=level]').getByRole('checkbox').check();
  await page.locator('[data-field=level]').getByRole('button',{name:'Add level value'}).click();
  await page.locator('#field-level').fill('3');
  await expect(page.locator('#field-level')).toHaveAttribute('min','1');
  await page.getByRole('textbox',{name:'Template name'}).fill('zero'); await page.getByRole('button',{name:'Save',exact:true}).click();
  const stored=await page.evaluate(()=>localStorage.getItem('clyops.web.templates.v1'));
  expect(stored).not.toContain('never-persist-this'); expect(stored).toContain('"dry_run":false'); expect(stored).toContain('"count":0'); expect(stored).not.toContain('browser-key');
  await page.locator('#field-count').fill('4'); await page.locator('#field-dry_run').selectOption('true');
  await page.locator('.template-row').getByRole('button',{name:'↳ zero',exact:true}).click();
  await expect(page.locator('#field-count')).toHaveValue('0');
  await expect(page.locator('#field-dry_run')).toHaveValue('false');
  await expect(page.locator('[data-field=key]').getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('button',{name:'Edit JSON',exact:false}).click();
  expect(await page.locator('#json-input').inputValue()).not.toContain('never-persist-this');
  await page.locator('#json-input').fill('{"count": 0, "dry_run": false, "email": "ops@example.com", "mode":"slow", "level":[3]}');
  await page.getByRole('button',{name:'Apply JSON'}).click();
  await page.getByRole('button',{name:'Run tool',exact:false}).click();
  await expect(page.locator('.result-status')).toContainText('Completed');
  const output=page.locator('.output').first(); await expect(output).toContainText('"count":0'); await expect(output).toContainText('"dry_run":false'); await expect(output).toContainText('"levels":[3]');
  expect(await page.locator('#api-key').inputValue()).toBe('');
});

test('destructive confirmation and stdin execution', async ({ page }) => {
  await connect(page); await choose(page,'erase');
  await expect(page.getByRole('button',{name:'Run tool',exact:false})).toBeDisabled();
  await page.getByRole('checkbox',{name:'I confirm'}).check();
  await page.getByRole('button',{name:'Run tool',exact:false}).click();
  await expect(page.locator('.output').first()).toContainText('confirmed');
  await choose(page,'echo'); await page.getByRole('checkbox',{name:'Provide stdin'}).check(); await page.locator('#stdin-text').fill('hello from the browser');
  await page.getByRole('checkbox',{name:'Run as a background job'}).uncheck();
  await page.getByRole('button',{name:'Run tool',exact:false}).click();
  await expect(page.locator('.output').first()).toContainText('hello from the browser');
});

test('uploaded paths execute without entering saved templates', async ({ page }) => {
  await connect(page); await choose(page,'inspect');
  await page.locator('[data-field=INPUT] input[type=file]').setInputFiles({name:'uploaded.txt',mimeType:'text/plain',buffer:Buffer.from('uploaded file content')});
  await page.getByRole('textbox',{name:'Template name'}).fill('no-upload');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  expect(await page.evaluate(()=>localStorage.getItem('clyops.web.templates.v1'))).not.toContain('uploaded.txt');
  await page.getByRole('button',{name:'Run tool',exact:false}).click();
  await expect(page.locator('.output').first()).toContainText('uploaded file content');
});

test('background cancellation and authenticated binary download', async ({ page }) => {
  await connect(page); await choose(page,'wait'); await page.getByRole('button',{name:'Run tool',exact:false}).click();
  await expect(page.locator('.active-job')).toBeVisible(); await page.locator('.active-job').getByRole('button',{name:'Cancel job'}).click();
  await expect(page.locator('.active-job')).not.toBeVisible();
  await expect(page.getByText('cancelled', {exact:true})).toBeVisible();
  await choose(page,'bytes'); await page.getByRole('button',{name:'Run tool',exact:false}).click(); await expect(page.locator('.result-status')).toContainText('Completed');
  const download=page.waitForEvent('download'); await page.getByRole('button',{name:'Download output'}).click();
  const file=await download; expect(file.suggestedFilename()).toContain('stdout');
  expect([...await readFile((await file.path())!)]).toEqual([0,1,255]);
  // A streamed job created by another client uses an authenticated output URL.
  const raw=await page.request.post('/tools/bytes?async=true',{headers:{Authorization:'Bearer browser-key',Accept:'application/octet-stream'},data:{}});
  expect(raw.status()).toBe(202); const job=await raw.json();
  const row=page.locator('.job-row').filter({hasText:job.job_id});
  await expect(row.getByRole('button',{name:'View result'})).toBeVisible();
  await row.getByRole('button',{name:'View result'}).click();
  const authenticated=page.waitForEvent('download'); await page.getByRole('button',{name:'Download output'}).click();
  expect([...await readFile((await (await authenticated).path())!)]).toEqual([0,1,255]);
});

test('ANSI stdout and stderr render colors safely, with a plain view and unchanged download', async ({ page }) => {
  await connect(page); await choose(page, 'colors');
  await page.getByRole('button', {name:'Run tool', exact:false}).click();
  const stdout = page.getByLabel('stdout', {exact:true});
  const stderr = page.getByLabel('stderr', {exact:true});
  await expect(stdout).toContainText('red stdout plain <img src=x onerror=alert(1)>');
  await expect(stdout.locator('span').filter({hasText:'red stdout'})).toHaveCSS('color', 'rgb(187, 0, 0)');
  await expect(stdout.locator('span').filter({hasText:'red stdout'})).toHaveCSS('font-weight', '700');
  await expect(stderr.locator('span').filter({hasText:'colored stderr'})).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(stdout.locator('img')).toHaveCount(0);
  await page.getByRole('checkbox', {name:'ANSI colors'}).uncheck();
  await expect(stdout.locator('span')).toHaveCount(0);
  await expect(stderr.locator('span')).toHaveCount(0);
  expect(await stdout.textContent()).not.toContain('\x1b');
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name:'Download stdout'}).click();
  expect(await readFile((await (await download).path())!, 'utf8')).toBe('\x1b[1;31mred stdout\x1b[0m plain <img src=x onerror=alert(1)>\n');
});

test('mobile connection and tools are accessible without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/ui/');
  await page.getByRole('button',{name:'Connection & tools',exact:true}).click();
  await page.locator('#api-key').fill('browser-key'); await page.getByRole('button',{name:'Connect to API'}).click();
  await expect(page.locator('.connection-status')).toHaveText('Connected');
  await page.getByRole('button',{name:'Connection & tools',exact:true}).click(); await choose(page,'plan');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
