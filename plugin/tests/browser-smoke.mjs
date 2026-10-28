import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserLauncher } from '../browser-launcher.mjs';
import { resolveBrowserExecutable } from '../browser-runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-macos-browser-test-'));
const profile = path.join(root, 'isolated-profile'), control = path.join(root, 'control');
const server = net.createServer();
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port; await new Promise(resolve => server.close(resolve));
let child, browser, output = '';
try {
  child = spawn(process.execPath, [fileURLToPath(new URL('../browser-host.mjs', import.meta.url)), profile, control, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  let state;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`浏览器宿主提前退出：${output}`);
    try { state = JSON.parse(fs.readFileSync(path.join(control, 'browser.json'))); } catch {}
    if (state?.ready) break;
    await delay(200);
  }
  assert.equal(state?.ready, true, output);
  assert.equal(state.profile, profile); assert.equal(state.port, port); assert.equal(state.pid, child.pid);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  // 本项只访问拦截的合成页面，不登录、不读取用户浏览器，也不请求抖音网络。
  await context.route('**/*', route => route.request().url().startsWith('https://www.douyin.com/')
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mac 浏览器验证</title><video muted autoplay></video><p>隔离测试</p>' })
    : route.abort());
  const launcher = new BrowserLauncher({ getBrowser: async () => browser });
  const opened = await launcher.open();
  assert.equal(opened.mode, 'prepare'); assert.equal(opened.paused, true);
  const page = context.pages().find(page => page.url().startsWith('https://www.douyin.com/'));
  const media = await page.evaluate(async () => {
    const video = document.querySelector('video'), canvas = document.createElement('canvas');
    const stream = canvas.captureStream(10); video.srcObject = stream;
    await video.play().catch(() => {});
    const result = { paused: video.paused, count: document.querySelectorAll('video').length, name: window.name };
    stream.getTracks().forEach(track => track.stop()); return result;
  });
  assert.equal(media.paused, true); assert.equal(media.name, 'deepseek-douyin-launcher');
  const reopened = await launcher.open(); assert.equal(reopened.reused, true);
  assert.equal(context.pages().filter(page => page.url().startsWith('https://www.douyin.com/')).length, 1);
  console.log(JSON.stringify({ ok: true, browser: resolveBrowserExecutable().label, browserVersion: browser.version(), isolatedProfile: true, hostReadiness: true, cdpConnected: true, preparePagePaused: media.paused, pageReused: reopened.reused, externalRequests: 0 }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(root, { recursive: true, force: true });
}
