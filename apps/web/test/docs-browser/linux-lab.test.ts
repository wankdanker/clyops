import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const terminal = (page: Page) => page.locator('.xterm-accessibility-tree');
async function command(page: Page, text: string) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}

test('Linux runs unchanged Bash/Python tools, FFmpeg, pipes and an actual local curl upload', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const assets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/linux-runtime/')) assets.push(request.url()); });
  await page.goto('./linux-lab.html');
  await expect(page.getByRole('button', {name:'Start Linux',exact:true})).toBeVisible();
  expect(assets).toHaveLength(0);
  await page.getByRole('button', {name:'Start Linux',exact:true}).click();
  await expect(page.locator('#lab-status')).toContainText('Ready ·', {timeout:120_000});
  await page.screenshot({path:test.info().outputPath('linux-lab-desktop.png'),fullPage:true});
  await page.getByRole('button', {name:'Python help',exact:true}).click();
  await expect(terminal(page)).toContainText('--replicas', {timeout:30_000});
  await command(page, "printf 'BASH_VERSION=%s\\n' \"$BASH_VERSION\"");
  await expect(terminal(page)).toContainText('BASH_VERSION=5.');
  await page.locator('#lab-upload').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('GUEST_UPLOAD_OK\n')});
  await expect(page.locator('#lab-transfer-status')).toContainText('Added /workspace/inbox/note.txt');
  await command(page, 'cat /workspace/inbox/note.txt');
  await expect(terminal(page)).toContainText('GUEST_UPLOAD_OK');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('plan.py --env pr');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(terminal(page)).toContainText('"env": "production"');
  await page.getByRole('button', {name:'Inspect media',exact:true}).click();
  await expect(terminal(page)).toContainText('"format_name": "wav"', {timeout:30_000});
  await page.getByRole('button', {name:'Transcode audio',exact:true}).click();
  await expect(terminal(page)).toContainText('muxing overhead', {timeout:60_000});
  await page.getByRole('button', {name:'Upload inside Linux',exact:true}).click();
  await expect(terminal(page)).toContainText('"received_bytes":', {timeout:30_000});
  await expect(terminal(page)).toContainText('"saved_to": "/tmp/uploads/');
  const file = page.waitForEvent('download');
  await page.getByRole('button', {name:'Download /tmp/tone.m4a'}).click();
  const downloaded = await file;
  expect(downloaded.suggestedFilename()).toBe('tone.m4a');
  const bytes = await readFile((await downloaded.path())!);
  expect(bytes.length).toBeGreaterThan(1000); expect(bytes.subarray(4,8).toString()).toBe('ftyp');
  await page.getByRole('button', {name:'Pipe two tools',exact:true}).click();
  await expect(terminal(page)).toContainText('"env": "production"');
  await page.getByRole('button', {name:'Stop & reset',exact:true}).click();
  await expect(page.getByRole('button', {name:'Start Linux',exact:true})).toBeEnabled();
  await expect(page.getByRole('button', {name:'Inspect media',exact:true})).toBeDisabled();
  await page.getByRole('button', {name:'Start Linux',exact:true}).click();
  await expect(page.locator('#lab-status')).toContainText('Ready ·', {timeout:120_000});
  await command(page, "test ! -e /workspace/inbox/note.txt && echo FRESH_GUEST_''OK");
  await expect(terminal(page)).toContainText('FRESH_GUEST_OK');
  await page.getByRole('button', {name:'Stop & reset',exact:true}).click();
  expect(errors).toEqual([]);
});

test('Linux lab layout and startup failure work on mobile', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.route('**/linux-runtime/*.wasm', route => route.abort());
  await page.goto('./linux-lab.html');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('linux-lab-mobile.png'),fullPage:true});
  await page.getByRole('button', {name:'Start Linux',exact:true}).click();
  await expect(page.locator('#lab-status')).toContainText('could not', {timeout:15_000});
  await expect(page.getByRole('button', {name:'Start Linux',exact:true})).toBeEnabled();
});
