import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBrowserExecutable } from '../browser-runtime.mjs';
import { resolveNodeExecutable, resolveMediaPython, resolveRuntimePaths } from '../runtime-paths.mjs';
import { runDiagnostics } from '../diagnostics.mjs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const resources = '/Applications/DeepSeek Harness.app/Contents/Resources';
const bundledNode = `${resources}/runtime/primary-runtime/dependencies/node/bin/node`;
const macBrowser = (files, env = {}) => resolveBrowserExecutable({ env, platform: 'darwin', home: '/Users/test', isExecutable: file => files.includes(file) });

test('macOS 已安装 Chrome 即可运行，不要求 Edge', () => {
  assert.deepEqual(macBrowser([chrome]), { id: 'chrome', label: 'Google Chrome', executablePath: chrome });
});
test('macOS 支持 Edge 和用户 Applications 目录', () => {
  assert.equal(macBrowser([edge]).id, 'msedge');
  const local = '/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(macBrowser([local]).executablePath, local);
});
test('明确指定的浏览器不可用时不偷偷切换', () => {
  assert.equal(macBrowser([chrome, edge], { DOUYIN_BROWSER: 'msedge' }).id, 'msedge');
  assert.throws(() => macBrowser([chrome], { DOUYIN_BROWSER: 'msedge' }));
  assert.throws(() => macBrowser([chrome], { DOUYIN_BROWSER: 'safari' }));
});
test('自定义程序支持空格路径，并拒绝无效或相对路径', () => {
  const file = '/opt/My Chromium/chromium';
  assert.equal(macBrowser([file], { DOUYIN_BROWSER_EXECUTABLE: file }).executablePath, file);
  for (const value of ['chrome', '/bad/path', '', '/tmp/x\n']) assert.throws(() => macBrowser([chrome], { DOUYIN_BROWSER_EXECUTABLE: value }));
});
test('Windows 默认继续选择 Edge，可回退 Chrome', () => {
  const root = 'C:\\Program Files';
  const expected = `${root}\\Microsoft\\Edge\\Application\\msedge.exe`;
  const options = { platform: 'win32', env: { PROGRAMFILES: root }, home: 'C:\\Users\\test' };
  assert.equal(resolveBrowserExecutable({ ...options, isExecutable: file => file === expected }).executablePath, expected);
  assert.equal(resolveBrowserExecutable({ ...options, isExecutable: file => file.endsWith('chrome.exe') }).id, 'chrome');
});
test('浏览器缺失时明确失败', () => {
  assert.throws(() => macBrowser([]), /未找到/);
});
test('Electron 宿主从自己的 primary-runtime 找到独立 Node', () => {
  const seen = [];
  const result = resolveNodeExecutable({ env: {}, versions: { electron: '1' }, executable: '/app/Electron', resourcesPath: resources, platform: 'darwin', probe: file => { seen.push(file); return file === bundledNode; } });
  assert.equal(result, bundledNode);
  assert.deepEqual(seen, [bundledNode]);
});
test('Mac GUI 没有 PATH 时仍能查找已安装的 DSH Node', () => {
  assert.equal(resolveNodeExecutable({ env: {}, versions: { electron: '1' }, executable: '/app/Electron', resourcesPath: undefined, platform: 'darwin', probe: file => file === bundledNode }), bundledNode);
});
test('现有真正 Node 优先使用且执行 SQLite 能力探测', () => {
  assert.equal(resolveNodeExecutable({ env: {}, executable: process.execPath, versions: process.versions }), process.execPath);
});
test('明确指定 Node 失败时保留错误，不偷偷回退', () => {
  assert.throws(() => resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: '/missing/node' }, probe: () => false }), /DOUYIN_NODE_EXECUTABLE/);
  assert.throws(() => resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: 'node' }, probe: () => true }), /DOUYIN_NODE_EXECUTABLE/);
});
test('拒绝用当前 Electron 程序冒充独立 Node', () => {
  assert.throws(() => resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: process.execPath }, executable: process.execPath, versions: { ...process.versions, electron: '1' } }), /独立 Node/);
});
test('Windows PATH 大小写、分隔符和带空格目录保留兼容', () => {
  const file = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(resolveNodeExecutable({ env: { Path: 'C:\\bad;"C:\\Program Files\\nodejs"' }, versions: { electron: '1' }, executable: 'C:\\DSH.exe', resourcesPath: undefined, platform: 'win32', probe: item => item === file }), file);
});
test('Mac PATH 之外支持常规 Homebrew Node 位置', () => {
  const expected = '/opt/homebrew/bin/node';
  assert.equal(resolveNodeExecutable({ env: {}, versions: { electron: '1' }, executable: '/app/Electron', platform: 'darwin', probe: file => file === expected }), expected);
});
test('Mac Python 使用自己的 venv 或 DSH runtime', () => {
  const local = '/media/.venv/bin/python3';
  assert.equal(resolveMediaPython({ platform: 'darwin', runtimeRoot: '/media', isFile: file => file === local }), local);
  const bundled = `${resources}/runtime/primary-runtime/dependencies/python/bin/python3`;
  assert.equal(resolveMediaPython({ platform: 'darwin', runtimeRoot: '/media', resourcesPath: resources, isFile: file => file === bundled }), bundled);
  assert.equal(resolveMediaPython({ platform: 'darwin', runtimeRoot: '/media', isFile: () => false }), 'python3');
});
test('Windows Python 继续支持 Scripts/python.exe，不引用 Codex runtime', () => {
  const seen = [], expected = 'C:\\media\\.venv\\Scripts\\python.exe';
  assert.equal(resolveMediaPython({ platform: 'win32', runtimeRoot: 'C:\\media', resourcesPath: 'C:\\DSH\\resources', isFile: file => { seen.push(file); return file === expected; } }), expected);
  resolveMediaPython({ platform: 'darwin', runtimeRoot: '/media', isFile: file => { seen.push(file); return false; } });
  assert.equal(seen.some(file => file.includes('codex')), false);
});
test('保持原有状态、记忆和浏览器资料目录映射', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-paths-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const locationFile = path.join(root, 'location.json');
  const stored = { version: 1, stateDir: path.join(root, 'existing-state'), memoryDir: path.join(root, 'existing-memory') };
  fs.writeFileSync(locationFile, JSON.stringify(stored));
  const result = resolveRuntimePaths({ env: { DOUYIN_RUNTIME_LOCATION_FILE: locationFile }, home: root, sourceRoot: path.join(root, 'plugin') });
  assert.equal(result.stateDir, stored.stateDir);
  assert.equal(result.memoryDbPath, path.join(stored.memoryDir, 'shared.sqlite'));
  assert.equal(result.browserProfileDir, path.join(root, '.dsh/douyin-browser/cli-profile'));
  assert.equal(fs.existsSync(stored.stateDir), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(locationFile)), stored);
});
test('诊断使用和启动相同的浏览器选择器，Node 与 SQLite 实测通过', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-diagnostics-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { paths: { stateDir: path.join(root, 'state'), memoryDir: path.join(root, 'memory') }, videoLimits: { state: () => ({ allowed: false }) }, nodeResolver: () => process.execPath, browserResolver: () => macBrowser([chrome]) };
  const result = await runDiagnostics(options);
  assert.equal(result.pluginVersion, '1.4.5-macos.1');
  assert.equal(result.checks.find(x => x.id === 'node').status, 'pass');
  assert.equal(result.checks.find(x => x.id === 'browser').evidence.browser, 'chrome');
  const missing = await runDiagnostics({ ...options, browserResolver: () => macBrowser([]) });
  assert.equal(missing.checks.find(x => x.id === 'browser').code, 'BROWSER_MISSING');
});
