// Headless app test; never attaches to the user's browser or desktop session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTokenizer } from '../harness/app/vibe2/tokenizer.js';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
const root = path.resolve(import.meta.dirname, '..');
const recording = JSON.parse(fs.readFileSync(path.join(root, 'frontend/public/brain/recorded-preview.json')));
const server = await createServer({ root: path.join(root, 'frontend'), configFile: path.join(root, 'frontend/vite.config.ts'), server: { port: 5175, strictPort: true, host: '127.0.0.1' } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && /THREE|WebGL|shader|GL_INVALID/i.test(msg.text())) errors.push(msg.text()); });
  await page.goto('http://127.0.0.1:5175/brain-preview.html');
  const canvas = page.locator('#brain');
  await page.waitForFunction(() => document.querySelector('#brain')?.dataset.nodes === '1958');
  await page.screenshot({ path: path.join(root, 'assets/brain/browser-whole-brain.png') });
  await page.getByRole('button', { name: 'Circuit detail' }).click();
  const before = await canvas.screenshot();
  await page.getByRole('button', { name: 'Play recording' }).click();
  await page.waitForTimeout(230);
  const after = await canvas.screenshot();
  assert.notDeepEqual(before, after, 'Recorded fires must change the rendered pixels');
  await page.screenshot({ path: path.join(root, 'assets/brain/browser-circuit.png') });
  await page.getByRole('button', { name: 'Pause recording' }).click();
  await page.waitForTimeout(1000);
  const resting = await canvas.screenshot();
  await page.waitForTimeout(150);
  assert.deepEqual(resting, await canvas.screenshot(), 'Idle renderer must stop changing pixels');
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  assert.notDeepEqual(resting, await canvas.screenshot(), 'Arrow keys must rotate the 3D view');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Play recording' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Pause recording' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Whole brain' }).click();
  await page.screenshot({ path: path.join(root, 'assets/brain/browser-mobile.png') });
  await canvas.evaluate(el => el.dispatchEvent(new Event('reset')));
  assert.equal(await canvas.getAttribute('data-nodes'), null);
  await canvas.evaluate((el, mapping) => el.dispatchEvent(new CustomEvent('mapping', { detail: mapping })), recording.mapping);
  assert.equal(await canvas.getAttribute('data-edges'), '19037');

  // Exercise trained browser inference through the real React protocol and 3D renderer.
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    // Vite's development-only hot reload socket is unrelated to inference.
    if (url.host !== '127.0.0.1:5175' || url.pathname !== '/' || !url.searchParams.has('token')) {
      errors.push(`Unexpected WebSocket: ${socket.url()}`);
    }
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:5175/');
  try {
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.nodes === '1959', undefined, { timeout: 120000 });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    throw error;
  }
  assert.equal(await page.locator('canvas').getAttribute('data-layout'), 'brain3d');
  assert.equal(await page.locator('canvas').getAttribute('data-edges'), '19037');
  await page.getByRole('button', { name: 'Focus model circuit' }).click();
  await page.locator('canvas').evaluate(el => el.dispatchEvent(new CustomEvent('node-select', { detail: { id: 100 } })));
  assert.ok((await page.locator('.atlas-inspector-mount').innerText()).includes('100'));
  await page.locator('canvas').evaluate(el => {
    window.brainTest = { fires: [], tokens: [] };
    el.addEventListener('fire', event => window.brainTest.fires.push(event.detail));
    el.addEventListener('telemetry', event => {
      if (event.detail.type === 'token_step') window.brainTest.tokens.push(event.detail);
    });
  });
  const golden = JSON.parse(fs.readFileSync(path.join(root, 'frontend/public/models/vibe2-tinystories/golden.json')));
  const tokenizer = createTokenizer(JSON.parse(fs.readFileSync(path.join(root, 'frontend/public/models/vibe2-tinystories/tokenizer.json'))));
  const expectedText = new TextDecoder().decode(Uint8Array.from(golden.greedy_ids.flatMap(id => [...tokenizer.tokenBytes(id)])));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Max tokens', { exact: true }).fill('32');
  await page.getByLabel('Temperature', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(golden.prompt);
  const idlePixels = await page.locator('canvas').screenshot();
  await page.getByRole('button', { name: 'Run prompt', exact: true }).click();
  await page.waitForFunction(() => window.brainTest.fires.length > 0, undefined, { timeout: 60000 });
  assert.notDeepEqual(idlePixels, await page.locator('canvas').screenshot(), 'Actual inference fires must change 3D pixels');
  await page.waitForFunction(() => document.querySelector('.response__status-row')?.textContent?.includes('Done'), undefined, { timeout: 120000 });
  assert.equal(await page.locator('.response__body pre').textContent(), expectedText);
  const observed = await page.evaluate(() => window.brainTest);
  assert.deepEqual(observed.tokens.filter(token => token.kind === 'completion').map(token => token.token_id), golden.greedy_ids);
  assert.equal(observed.tokens.at(-1).step_status, 'unprocessed');
  assert.equal(observed.fires.length, golden.steps.length);
  assert.ok(observed.fires.every(fire => fire.pairs.length > 0));
  assert.ok(!requests.some(url => /^\/(health|v1(?:\/|$)|stream(?:\/|$))/.test(url)), 'Inference must stay in-browser');
  assert.equal(requests.filter(url => url.endsWith('/weights.bin')).length, 1);
  await page.screenshot({ path: path.join(root, 'assets/brain/browser-live-workspace.png') });
  assert.deepEqual(errors, [], 'No runtime or GPU shader errors');
  console.log('PASS: full anatomy, recorded and inferred 3D fires, idle stop, orbit, reduced motion, mobile, reset, React inspector, 32/32 golden tokens, no backend requests or shader errors.');
} finally {
  await browser?.close();
  await server.close();
}
