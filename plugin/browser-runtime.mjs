import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

function executableFile(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// 启动与自检共用同一份选择逻辑；始终由调用方传入专用 user-data-dir。
export function resolveBrowserExecutable({ env = process.env, platform = process.platform, home = homedir(), isExecutable = file => executableFile(file, platform) } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const explicit = env.DOUYIN_BROWSER_EXECUTABLE;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || /[\0\r\n]/.test(explicit) || !paths.isAbsolute(explicit) || !isExecutable(explicit)) {
      throw new Error('DOUYIN_BROWSER_EXECUTABLE 必须指向可执行的 Chrome、Edge 或 Chromium 程序绝对路径。');
    }
    return { id: 'custom', label: '自定义 Chromium 浏览器', executablePath: paths.normalize(explicit) };
  }
  const preferred = env.DOUYIN_BROWSER || 'auto';
  if (!['auto', 'chrome', 'msedge', 'chromium'].includes(preferred)) throw new Error('DOUYIN_BROWSER 只支持 auto、chrome、msedge 或 chromium。');
  const candidates = [];
  const add = (id, label, file) => candidates.push({ id, label, executablePath: file });
  if (platform === 'darwin') {
    for (const [id, app, binary] of [
      ['chrome', 'Google Chrome', 'Google Chrome'],
      ['msedge', 'Microsoft Edge', 'Microsoft Edge'],
      ['chromium', 'Chromium', 'Chromium'],
    ]) for (const root of ['/Applications', paths.join(home, 'Applications')]) {
      add(id, app, paths.join(root, `${app}.app`, 'Contents', 'MacOS', binary));
    }
  } else if (platform === 'win32') {
    for (const [id, label, relative] of [
      ['msedge', 'Microsoft Edge', ['Microsoft', 'Edge', 'Application', 'msedge.exe']],
      ['chrome', 'Google Chrome', ['Google', 'Chrome', 'Application', 'chrome.exe']],
    ]) for (const root of [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean)) {
      add(id, label, paths.join(root, ...relative));
    }
  }
  const selected = candidates.find(candidate => (preferred === 'auto' || candidate.id === preferred) && isExecutable(candidate.executablePath));
  if (!selected) throw new Error('未找到可用的 Chrome 或 Microsoft Edge。请安装浏览器，或设置 DOUYIN_BROWSER_EXECUTABLE 为程序的绝对路径。');
  return selected;
}

export function browserDisplayName() {
  try { return resolveBrowserExecutable().label; }
  catch { return 'Google Chrome 或 Microsoft Edge'; }
}
