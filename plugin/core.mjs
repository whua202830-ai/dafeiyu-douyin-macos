import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from './playwright-runtime.mjs';
import { MemoryStore } from './memory.mjs?v=2';
import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=18';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths, resolveNodeExecutable } from './runtime-paths.mjs?v=macos.1';
import { PersonaMemory } from './persona-memory.mjs?v=10';
import { BrowserLauncher, connectDedicatedBrowser } from './browser-launcher.mjs?v=macos.1';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_ACTIONS=new Set(['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen']);
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)throw new Error('共享视频操作锁无效。');try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const optionalRecord=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('共享视频操作记录无法读取，未操作视频。');}};
async function watchControl(directory,action,signal) {
  const file=path.join(directory,'watch-control.guard'),token=randomUUID();
  for(let attempt=0;;attempt++) {
    signal?.throwIfAborted(); let descriptor;
    try {descriptor=openSync(file,'wx',0o600);}
    catch(error){if(error.code!=='EEXIST'||attempt>=100)throw Object.assign(new Error('共享视频控制正在更新，请稍后重试。'),{status:409});await wait(20,signal);continue;}
    try {writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}));}
    finally {closeSync(descriptor);}
    try{return action();}finally{if(optionalRecord(file)?.token===token)unlinkSync(file);}
  }
}
async function acquireNativeVideoLease(directory,signal) {
  const file=path.join(directory,'watch-manual.lock'),token=randomUUID();
  await watchControl(directory,()=>{
    const owner=optionalRecord(path.join(directory,'watch-loop.lock'));
    if(owner)throw Object.assign(new Error('自主观看正在运行或需要清理残留，请先停止它再手动操作视频。'),{status:409});
    const manual=optionalRecord(file);
    if(manual&&processAlive(manual.pid))throw Object.assign(new Error('另一个入口正在手动操作视频，请等待完成。'),{status:409});
    writeFileSync(file,JSON.stringify({pid:process.pid,token,kind:'native-tool'}),{mode:0o600});
  },signal);
  return ()=>watchControl(directory,()=>{const manual=optionalRecord(file);if(manual?.pid===process.pid&&manual.token===token)unlinkSync(file);});
}
const { browserProfileDir: PROFILE, browserControlDir: CONTROL } = resolveRuntimePaths();
const RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PORT = 9227;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function aborted(signal) { signal?.throwIfAborted(); }
async function wait(ms, signal) { await delay(ms, undefined, { signal }); }

const QUEUES = Symbol.for('dafeiyu.browser-operation-queues.v1');
const localQueues = globalThis[QUEUES] ||= new Map();
const lockFailure = name => Object.assign(new Error(`${name.endsWith('-chat') ? '聊天窗口' : '浏览器窗口'}排队等待超时，请检查当前操作。`), { code:'BROWSER_LOCK_BUSY', lockName:name, status:409 });
async function localTurn(key, signal, timeoutMs, name) {
  const previous=localQueues.get(key)||Promise.resolve();let finish;
  const gate=new Promise(resolve=>{finish=resolve;}),tail=previous.catch(()=>{}).then(()=>gate);
  localQueues.set(key,tail);void tail.then(()=>{if(localQueues.get(key)===tail)localQueues.delete(key);});
  let timer,onAbort;
  try {
    aborted(signal);
    await Promise.race([previous.catch(()=>{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(lockFailure(name)),timeoutMs);if(signal){onAbort=()=>reject(signal.reason||new Error('已取消排队。'));signal.addEventListener('abort',onAbort,{once:true});}})]);
    aborted(signal);return finish;
  } catch(error) {finish();throw error;}
  finally {clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}

export async function acquireBrowserOperationLock(name,{signal,directory=CONTROL,timeoutMs=35_000}={}) {
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(name)||!path.isAbsolute(directory)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('浏览器操作锁参数无效。');
  const started=Date.now(),key=path.resolve(directory)+String.fromCharCode(0)+name,releaseTurn=await localTurn(process.platform==='win32'?key.toLowerCase():key,signal,timeoutMs,name);
  const file=path.join(directory,`${name}.lock`),token=randomUUID(),deadline=started+timeoutMs;
  try {
    mkdirSync(directory,{recursive:true});
    while(true) {
      aborted(signal);let descriptor;
      try {descriptor=openSync(file,'wx',0o600);}
      catch(error) {
        if(error.code!=='EEXIST')throw error;
        let raw,owner;
        try {raw=readFileSync(file,'utf8');owner=JSON.parse(raw);}
        catch(failure) {
          if(failure.code==='ENOENT')continue;
          let fresh=false;
          try{fresh=Date.now()-statSync(file).mtimeMs<2000;}catch(error){if(error.code==='ENOENT')continue;throw error;}
          if(failure instanceof SyntaxError&&fresh&&Date.now()<deadline){await wait(Math.min(50,timeoutMs),signal);continue;}
          throw Object.assign(new Error('浏览器操作锁记录无法核对，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});
        }
        if(!Number.isSafeInteger(owner?.pid)||owner.pid<1)throw Object.assign(new Error('浏览器操作锁归属不明，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});
        let ownerAlive;
        try{process.kill(owner.pid,0);ownerAlive=true;}catch(error){if(error.code==='ESRCH')ownerAlive=false;else if(error.code==='EPERM')ownerAlive=true;else throw Object.assign(new Error('浏览器操作锁进程无法核实，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});}
        if(!ownerAlive) {
          try{if(readFileSync(file,'utf8')===raw){unlinkSync(file);continue;}}
          catch(error){if(error.code==='ENOENT')continue;throw error;}
        }
        if(Date.now()>=deadline)throw lockFailure(name);
        await wait(Math.min(50,timeoutMs),signal);continue;
      }
      try{writeFileSync(descriptor,JSON.stringify({pid:process.pid,token,createdAt:Date.now()}));}finally{closeSync(descriptor);}
      let released=false;
      return ()=>{if(released)return;released=true;try{const owner=JSON.parse(readFileSync(file,'utf8'));if(owner.pid!==process.pid||owner.token!==token)throw Object.assign(new Error('浏览器操作锁归属已经变化，未删除其他操作的锁。'),{code:'BROWSER_LOCK_CHANGED',lockName:name,status:409});unlinkSync(file);}finally{releaseTurn();}};
    }
  }catch(error){releaseTurn();throw error;}
}
const lock=(name,signal,directory=CONTROL)=>acquireBrowserOperationLock(name,{signal,directory});

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
  } catch { return false; }
}
export function dedicatedHostReadiness(state, { pid, profile, port, processAlive = alive } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) return 'failed';
  // 新宿主写入前可能仍读到旧的已退出记录；只核对本次等待的进程。
  if (!state || state.pid !== pid) return 'pending';
  if (state.profile !== profile || state.port !== port) return 'foreign';
  return state.ready === true ? 'ready' : 'pending';
}
async function endpoint(signal) {
  const release = await lock('launch', signal);
  try {
    const stateFile = path.join(CONTROL, 'browser.json');
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 首次运行没有状态。 */ }
    const owned = state?.profile === PROFILE && state.port === PORT && alive(state.pid);
    if (await version()) {
      if (!owned || !state.ready) throw new Error('9227 端口不属于本工具的专用浏览器，请先释放端口。');
      return `http://127.0.0.1:${PORT}`;
    }
    let hostPid = state?.pid;
    if (!owned) {
      const output = openSync(path.join(CONTROL, 'browser-host.log'), 'a');
      try {
        const child = spawn(resolveNodeExecutable(), [path.join(ROOT, 'browser-host.mjs'), PROFILE, CONTROL, String(PORT)], {
          detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        hostPid = child.pid;
        child.unref();
      } finally { closeSync(output); }
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      aborted(signal);
      await wait(250, signal);
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = null; }
      const readiness = dedicatedHostReadiness(state, { pid: hostPid, profile: PROFILE, port: PORT });
      if (readiness === 'failed') throw new Error('专用浏览器启动失败；请正常关闭仍使用 cli-profile 的旧专用窗口后重试。');
      if (readiness === 'foreign') throw new Error('专用浏览器宿主归属无法核对，未连接该端口。');
      if (readiness === 'ready' && await version()) return `http://127.0.0.1:${PORT}`;
    }
    throw new Error('专用浏览器启动超时，请查看本机 browser-host.log。');
  } finally { release(); }
}

// 此函数仅读取网页 DOM 和 HTMLVideoElement，不调用抖音私有接口。
export function readPageState() {
  if(location.origin!=='https://www.douyin.com') return {
    url:null,title:null,video:null,searchResults:[],visibleText:'',loginRequired:false,verificationRequired:false,
    unsupportedPage:true,note:'当前专用标签页已离开抖音，没有读取该页面内容。',
  };
  const visible = element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const workId = value => {
    try { const u = new URL(value, location.href); return /\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  const videoVisible = element => {
    if(!visible(element))return false;
    for(let node=element;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;
    return true;
  };
  const videoElements = [...document.querySelectorAll('video')].filter(e=>videoVisible(e)&&!e.closest(privateArea)).map(element => {
    const r = element.getBoundingClientRect();
    return { element, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
  }).sort((a,b) => b.area - a.area);
  const element = videoElements[0]?.element;
  const text = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(e => clean(e.innerText || e.textContent)).filter(Boolean).join('\n').slice(-9000);
  const loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  const verificationRequired = [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible) || /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);
  let video = null, activeContainer = null, videoIdentityConflict = false;
  if (element) {
    let container = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    activeContainer = container;
    if(!container) {
      container=element.parentElement;
      for(let i=0;container?.parentElement&&i<8;i++) {
        if(container.querySelector('[class*="video-info-detail"]')) break;
        container=container.parentElement;
      }
    }
    const links = [...(container?.querySelectorAll('a[href]') ?? [])].filter(e=>visible(e)&&!e.closest(privateArea));
    const playerId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(element.closest('[data-e2e="player-container"]')?.className??'')?.[1],activeId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(activeContainer?.className??'')?.[1];
    videoIdentityConflict=Boolean(playerId&&activeId&&playerId!==activeId);
    const id = videoIdentityConflict?null:playerId || activeId || links.map(e=>workId(e.href)).find(Boolean) || workId(location.href) || null;
    const authorElement = links.find(e => /\/user\//.test(e.href)) || [...(container?.querySelectorAll('span,div')??[])].find(e=>e.childElementCount===0 && /^@/.test(clean(e.textContent)) && visible(e));
    const titleElement = container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]');
    const detailAuthor=container?.querySelector('[data-e2e="related-video"]')?.innerText?.split('\n').map(clean).find(Boolean);
    const captionAuthor=/@([^·\n]+)·/.exec(titleElement?.textContent??'')?.[1]?.trim();
    const r = element.getBoundingClientRect();
    video = { id, url: id ? `https://www.douyin.com/video/${id}` : null,
      author: clean(authorElement?.textContent).replace(/^@\s*/, '') || detailAuthor || captionAuthor || null,
      title: clean(titleElement?.getAttribute('data-e2e')==='detail-video-info'?titleElement.innerText.split('\n')[0]:titleElement?.textContent) || clean(links.find(e=>workId(e.href))?.textContent) || null,
      time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused, muted: element.muted, readyState: element.readyState,
      width: element.videoWidth, height: element.videoHeight,
      viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
  }
  const route = new URL(location.href);
  const recommendFeed = ['/', '/recommend', '/recommend/'].includes(route.pathname) && !workId(route.href);
  const feedCards = [...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(e => visible(e) && !e.closest(privateArea));
  if (!activeContainer && feedCards.length === 1) activeContainer = feedCards[0];
  let livePreview = null;
  if (recommendFeed && activeContainer?.matches('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]') && !video?.id && !privateChatVisible && !loginRequired && !verificationRequired) {
    const roomIds = [...activeContainer.querySelectorAll('a[href]')].filter(visible).map(link => {
      try { const target = new URL(link.href, location.href); return target.origin === 'https://live.douyin.com' ? /^\/(\d{4,30})\/?$/.exec(target.pathname)?.[1] : null; } catch { return null; }
    }).filter(Boolean);
    const unique = [...new Set(roomIds)];
    if (unique.length === 1) {
      const r = (element || activeContainer).getBoundingClientRect();
      livePreview = { recognized: true, source: 'active-feed-live-link', scope: 'recommend-feed', roomId: unique[0],
        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
    }
  }
  const searchResults = [];
  if (location.pathname.startsWith('/search/')) {
    const candidates = [...document.querySelectorAll('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]')].filter(visible);
    const used = new Set();
    for (const candidate of candidates) {
      const anchor = candidate.matches('a') ? candidate : candidate.querySelector('a[href*="/video/"],a[href*="modal_id="]');
      const id = workId(anchor?.href) || candidate.getAttribute('data-aweme-id') || /waterfall_item_(\d+)/.exec(candidate.closest('[id^="waterfall_item_"]')?.id??'')?.[1];
      const card = candidate.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]') || candidate;
      const leaves = [...card.querySelectorAll('div,span')].filter(e=>!e.childElementCount).map(e=>clean(e.textContent));
      const title = clean(card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]')?.textContent) || leaves.sort((a,b)=>b.length-a.length)[0] || clean(card.textContent);
      if (!title || used.has(id || title)) continue;
      used.add(id || title);
      searchResults.push({ index: searchResults.length, id: id || null, url: id ? `https://www.douyin.com/video/${id}` : null,
        title: title.slice(0,1000), author: clean(card.querySelector('a[href*="/user/"]')?.textContent).replace(/^@\s*/, '') || /@([^\n·]+)/.exec(card.innerText)?.[1]?.trim() || null });
    }
  }
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, videoSelection: { candidateCount: videoElements.length, ambiguous: videoElements.length > 1 || videoIdentityConflict, identityConflict: videoIdentityConflict }, pageKind: livePreview ? 'live-preview' : video?.id ? 'video' : location.pathname.startsWith('/search/') ? 'search' : 'unknown', livePreview, searchResults: searchResults.slice(0,20), visibleText: text,
    loginRequired, verificationRequired, privateChatVisible, documentReadyState: document.readyState };
}

export class BrowserController {
  constructor({ source = 'api', memory, videoLimits, personaMemory, controlDirectory = CONTROL } = {}) {
    if (!['api','dsh','verification','api-chat','dsh-chat'].includes(source)) throw new TypeError('不支持这个浏览器入口。');
    if(!path.isAbsolute(controlDirectory))throw new TypeError('浏览器控制目录须为绝对路径。');
    this.controlDirectory=controlDirectory;
    this.source = source; this.memory = memory; this.personaMemory = personaMemory; this.browser = null; this.page = null;
    this.queue = Promise.resolve();
    this.videoLimits = videoLimits;
    this.limitsEnabled = ['api','dsh'].includes(source);
  }
  limits() { return this.videoLimits ??= new VideoLimits(); }
  getMediaAdapter() { return this.mediaPromise??=import('./media/index.mjs?v=macos.1').then(({MediaAdapter})=>new MediaAdapter()); }
  getForwarder() { return this.forwarderPromise??=import('./video-forward.mjs?v=10').then(({VideoForwarder})=>new VideoForwarder({videoLimits:this.limits(),source:this.source==='dsh'?'dsh':'api'})); }
  watchVideoLimits() {
    if (!this.limitsEnabled || this.cancelLimitsWatch) return;
    this.cancelLimitsWatch = this.limits().watch({ sources:[this.source], pause:()=>this.pauseForLimits() });
  }
  async checkVideoLimits(name) {
    if (!this.limitsEnabled) return;
    const decision=this.limits().beforeAction(this.source,name);
    if (!decision.allowed) {
      await this.pauseForLimits();
      throw new Error(decision.reason || '当前不在允许的刷视频时间内，请在本机设置开始一轮。');
    }
  }
  async pauseForLimits() {
    if (!['api','dsh'].includes(this.source)) return { paused:0, existingPage:false };
    let accountingError;
    try { this.limits().settleWatching?.(this.source); } catch(error) { if(error.code!=='VIDEO_CONTROL_BUSY')accountingError=error; }
    let connection=this.browser, temporary=false;
    try {
      if(!connection?.isConnected()) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(CONTROL,'browser.json'),'utf8')); } catch { return {paused:0,existingPage:false}; }
        if(owner.profile!==PROFILE || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
        connection=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`,{timeout:3000}); temporary=true;
      }
      let paused=0,existingPage=false;
      for(const candidate of connection.contexts().flatMap(context=>context.pages())) {
        if(candidate.isClosed() || await candidate.evaluate(()=>window.name).catch(()=>'')!==`deepseek-douyin-${this.source}`) continue;
        existingPage=true;
        paused+=await candidate.evaluate(()=>{
          if(location.origin!=='https://www.douyin.com') return 0;
          let count=0;
          for(const video of document.querySelectorAll('video')) {if(!video.paused) count++;video.pause();}
          return count;
        }).catch(()=>0);
      }
      return {paused,existingPage};
    } finally {
      if(temporary) await connection?.close().catch(()=>{});
      for(let attempt=0;attempt<5;attempt++){try{this.limits().settleWatching?.(this.source);break;}catch(error){if(error.code!=='VIDEO_CONTROL_BUSY'){accountingError ||=error;break;}if(attempt<4)await new Promise(resolve=>setTimeout(resolve,25));}}
      if(accountingError)throw accountingError;
    }
  }
  store() { return this.memory ??= new MemoryStore(resolveRuntimePaths().memoryDbPath); }
  getPersonaMemory() {
    if (!this.personaMemory) {
      this.personaMemory = new PersonaMemory({ memoryDir: path.dirname(this.memory?.dbPath || resolveRuntimePaths().memoryDbPath) });
      this.personaMemory.initialize({ importLegacy: false });
    }
    return this.personaMemory;
  }
  getChatService() {
    this.chatPromise??=Promise.all([import('./chat-browser.mjs?v=18'),import('./chat-service.mjs?v=18'),import('./usage-ledger.mjs')])
      .then(([{ChatBrowser},{ChatService},{UsageLedger}])=>{const stateDir=this.limits().stateDir,source=this.source==='dsh'?'dsh':'api';const service=new ChatService({stateDir,browser:new ChatBrowser({source:source==='dsh'?'dsh-chat':'api-chat'})});service.agent.personaMemory=this.getPersonaMemory();service.agent.usageLedger=new UsageLedger({stateDir});service.agent.source=source;return service;})
      .catch(error=>{this.chatPromise=null;throw error;});
    return this.chatPromise;
  }
  getSparkService() {
    this.sparkPromise ??= Promise.all([this.getChatService(), import('./spark-service.mjs?v=18')]).then(([chat, { SparkService }]) => new SparkService({ browser: chat.browser, config: chat.config, personaMemory: this.getPersonaMemory(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.sparkPromise = null; throw error; });
    return this.sparkPromise;
  }
  getCommenter() {
    this.commenterPromise ??= import('./comment-browser.mjs?v=18').then(({ CommentBrowser }) => new CommentBrowser({ source: this.source === 'dsh' ? 'dsh' : 'api', videoLimits: this.limits(), stateDir: this.limits().stateDir })).catch(error => { this.commenterPromise = null; throw error; });
    return this.commenterPromise;
  }
  getComments() {
    this.commentsPromise ??= import('./autonomous-comments.mjs?v=10').then(({ AutonomousComments }) => new AutonomousComments({ controller: this, personaMemory: this.getPersonaMemory(), videoLimits: this.limits(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.commentsPromise = null; throw error; });
    return this.commentsPromise;
  }
  getReport() {
    this.reportPromise ??= import('./daily-report.mjs?v=10').then(({ DailyReport }) => new DailyReport({ personaMemory: this.getPersonaMemory() })).catch(error => { this.reportPromise = null; throw error; });
    return this.reportPromise;
  }
  getWatchMode() {
    this.modePromise ??= import('./watch-mode.mjs?v=18').then(({ WatchMode }) => new WatchMode({ stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' }));
    return this.modePromise;
  }
  async applyWatchMode({ minimize = false } = {}) {
    if (!['api', 'dsh'].includes(this.source)) return { applied: false, reason: '当前入口不管理视频静默设置。' };
    const mode = await this.getWatchMode();
    return mode.applyBrowser(await this.connectExistingBrowser(), { minimize });
  }
  async connectExistingBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    let owner;
    try { owner = JSON.parse(readFileSync(path.join(CONTROL, 'browser.json'), 'utf8')); } catch { return null; }
    if (owner.profile !== PROFILE || owner.port !== PORT || !owner.ready || !alive(owner.pid) || !await version()) return null;
    // 保存静默设置只重新连接已经存在的专用浏览器，不启动窗口或新建标签。
    this.browser = await connectDedicatedBrowser(`http://127.0.0.1:${PORT}`);
    return this.browser;
  }
  openBrowser({ signal } = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await lock('browser-launcher', signal,this.controlDirectory);
      try {
        this.browserLauncher ??= new BrowserLauncher({
          getBrowser: async currentSignal => { if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(currentSignal), { signal: currentSignal }); this.page = null; } return this.browser; },
          getWatchState: () => { const worker = optionalRecord(path.join(this.limits().stateDir, 'watch-loop.lock')); if (!worker) return null; if (!Number.isSafeInteger(worker.pid) || worker.pid < 1 || !['api', 'dsh'].includes(worker.source) || typeof worker.runId !== 'string') throw new Error('自主观看锁无法核对，未打开或改动入口页。'); return alive(worker.pid) ? worker : null; },
        });
        return await this.browserLauncher.open({ signal });
      } finally { release(); }
    });
    this.queue = operation; return operation;
  }
  async connect(signal) {
    aborted(signal);
    const label=`deepseek-douyin-${this.source}`;
    if(this.browser?.isConnected()&&this.page&&!this.page.isClosed()) {
      if(this.source==='verification')return this.page;
      if(await this.page.evaluate(()=>window.name).catch(()=>null)===label) {
        let owned=0;
        for(const candidate of this.browser.contexts()[0].pages()){aborted(signal);if(!candidate.isClosed()&&await candidate.evaluate(()=>window.name).catch(()=>null)===label)owned++;}
        if(owned>1)throw new Error('发现多个归属相同的专用标签，请保留一个后再试。');
        if(owned===1)return this.page;
      }
      this.page=null;
    }
    if(!this.browser?.isConnected()){this.browser=await connectDedicatedBrowser(await endpoint(signal),{signal});this.page=null;}
    const releaseClaim=await lock('tab-claim',signal,this.controlDirectory);
    try {
      const context=this.browser.contexts()[0],matching=[];
      for(const candidate of context.pages()){aborted(signal);if(!candidate.isClosed()&&await candidate.evaluate(()=>window.name).catch(()=>null)===label)matching.push(candidate);}
      if(matching.length>1)throw new Error('发现多个归属相同的专用标签，请保留一个后再试。');
      this.page=matching[0]||null;
      if(!this.page){
        const initial=[];
        for(const candidate of context.pages()){if(candidate.isClosed()||candidate.url()!=='about:blank')continue;if(await candidate.evaluate(()=>!window.name&&!document.body?.textContent?.trim()&&document.querySelectorAll('body *').length===0).catch(()=>false))initial.push(candidate);}
        this.page=initial.length===1?initial[0]:await context.newPage();
        await this.page.evaluate(name=>{window.name=name;},label);
      }
      this.page.setDefaultTimeout(10_000);this.page.setDefaultNavigationTimeout(25_000);aborted(signal);
      if(await this.page.evaluate(()=>window.name)!==label)throw new Error('专用标签页归属未通过核对，未继续操作。');
    }finally{releaseClaim();}
    if(this.page.url()==='about:blank') {
      if(this.source.endsWith('-chat')){await this.page.goto(RECOMMEND,{waitUntil:'domcontentloaded'});await this.page.evaluate(name=>{window.name=name;},label);await this.page.locator('[data-e2e="im-entry"]').waitFor({state:'visible',timeout:15_000});}
      else await this.navigate(RECOMMEND,signal);
    }
    return this.page;
  }

  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(name => { window.name = name; }, `deepseek-douyin-${this.source}`);
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/video\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    for (let i=0;i<16;i++) {
      aborted(signal);
      const state = await this.page.evaluate(readPageState);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/video\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      if(kind==='video' && detail && state.video?.id===videoId && state.video.readyState>=2) return state;
      if(kind==='recommend' && (state.video?.id && state.video.readyState>=2 || state.livePreview?.recognized === true)) return state;
      await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  async state({ record = true } = {}) {
    const state = await this.page.evaluate(readPageState);
    if (['api','dsh'].includes(this.source)) this.limits().notePlayback?.(this.source,state);
    if (record && state.video?.id) {
      try { this.store().recordVideo(state, this.source); } catch { state.memoryWarning = '视频状态已读取，记忆记录暂不可用。'; }
    }
    return state;
  }
  withPage(callback,{signal}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const release=await lock(`tab-${this.source}`,signal,this.controlDirectory);
      const onAbort=()=>{this.browser?.close().catch(()=>{});};
      signal?.addEventListener('abort',onAbort,{once:true});
      try {
        aborted(signal);
        const page=await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) await (await this.getWatchMode()).apply(page);
        if(new URL(page.url()).origin!=='https://www.douyin.com') throw new Error('专用标签页已离开抖音，请重新打开抖音后操作。');
        return await callback(page,signal);
      }finally{signal?.removeEventListener('abort',onAbort);release();}
    });
    this.queue=operation;return operation;
  }
  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId, expectedVideoId } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    try { validateToolArguments(definition,args); } catch(error) { return Promise.reject(error); }
    if(expectedVideoId!==undefined&&(!['douyin_next','douyin_previous'].includes(name)||typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))return Promise.reject(new TypeError('预期作品ID只供换片宿主使用，须为纯数字字符串。'));
    if (name.startsWith('douyin_diagnostics')) {
      if (!this.diagnosticsService) return Promise.reject(new Error('诊断服务尚未加载，请更新插件或软件。'));
      signal?.throwIfAborted();
      return name === 'douyin_diagnostics' ? this.diagnosticsService.run() : this.diagnosticsService.repair(args, { signal });
    }
    const operation = this.queue.catch(()=>{}).then(async()=>{
      let releaseNativeLease;
      try {
      aborted(signal);
      if(this.source==='dsh'&&!autonomousRunId&&VIDEO_ACTIONS.has(name)) releaseNativeLease=await acquireNativeVideoLease(this.limits().stateDir,signal);
      if (this.limitsEnabled && ['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen','douyin_pause'].includes(name)) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(this.limits().stateDir,'watch-loop.lock'),'utf8')); }
        catch(error) { if(error.code!=='ENOENT' && name!=='douyin_pause') throw new Error('自主观看锁无法核对，未操作视频。'); }
        if(owner) {
          let living=false;
          if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.runId!=='string') { if(name!=='douyin_pause')throw new Error('自主观看锁无效，未操作视频。'); }
          else { try {process.kill(owner.pid,0);living=true;}catch(error){living=error.code==='EPERM';} }
          if(living && owner.runId!==autonomousRunId) {
            if(name!=='douyin_pause') throw Object.assign(new Error('自主观看正在运行，请先停止它再手动操作视频。'),{status:409});
            const requestFile=path.join(this.limits().stateDir,'watch-stop.request.json'),temporary=`${requestFile}.${randomUUID()}.tmp`;
            try {writeFileSync(temporary,JSON.stringify({runId:owner.runId,requestedAt:Date.now()}),{flag:'wx'});renameSync(temporary,requestFile);}
            finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
          }
        }
      }
      if(name.startsWith('douyin_chat_')) {
        const chat=await this.getChatService();aborted(signal);
        if(name==='douyin_chat_contacts') return chat.listContacts({signal});
        if(name==='douyin_chat_status') return chat.state();
        if(name==='douyin_chat_start') return chat.start({signal});
        if(name==='douyin_chat_stop') return chat.stop();
        if(name==='douyin_chat_read') return chat.readConversation(args.recipientId,{signal});
        if(name==='douyin_chat_observe') return chat.observeMessage(args.recipientId,args.messageId,{signal});
      }
      if (name.startsWith('douyin_spark_')) {
        if(name==='douyin_spark_start') throw new Error('自动续火花功能已移除。');
        const spark = await this.getSparkService(); aborted(signal);
        if (name === 'douyin_spark_status') return spark.state();
        if (name === 'douyin_spark_start') return spark.start({ schedule: true, explicit: true });
        if (name === 'douyin_spark_stop') return spark.stop({ explicit: true });
      }
      if (name === 'douyin_report_status') return (await this.getReport()).state();
      if (name === 'douyin_report_generate') return (await this.getReport()).generate({ reason: 'manual' });
      if(name==='douyin_media_status') return (await this.getMediaAdapter()).status();
      if(name==='douyin_forward_video') {
        if(humanAuthorized!==true) return {sent:false,requiresUserAction:true,note:'请在本机控制台选择这位好友并点击转发；此工具不会代替人类按钮授权。',recipientId:args.recipientId,url:args.url??null};
        return (await this.getForwarder()).forward(args,{signal,humanAuthorized:true});
      }
      if (name==='douyin_recall') return this.store().recall({query:args.query??'',limit:args.limit??10});
      if (name==='douyin_persona_status') return this.getPersonaMemory().snapshot();
      if (name==='douyin_watch_status') {
        const {AutonomousWatch}=await import('./autonomous-watch.mjs?v=10');
        this.watchStatusReader??=new AutonomousWatch({controller:this,config:{},videoLimits:this.limits(),personaMemory:this.getPersonaMemory(),source:this.source==='dsh'?'dsh':'api',stateDir:this.limits().stateDir});
        return this.watchStatusReader.state();
      }
      if (name==='douyin_interest_record') return this.getPersonaMemory().updateAgentInterests({ evidenceId:args.evidenceId,topics:[{topic:args.topic,signal:args.signal}],reflection:args.reflection },{source:this.source==='dsh'?'dsh':'api'});
      if (name==='douyin_remember') {
        const state = this.page && !this.page.isClosed() ? await this.state({record:false}) : null;
        return this.store().remember({content:args.content,kind:args.kind??'note',source:this.source,
          videoId:state?.video?.id,url:state?.video?.url,author:state?.video?.author,title:state?.video?.title});
      }
      if(name==='douyin_video_limits_status') return this.limits().state();
      this.watchVideoLimits();
      await this.checkVideoLimits(name);
      const release = await lock(`tab-${this.source}`,signal,this.controlDirectory);
      let onAbort;
      try {
        onAbort = () => { this.browser?.close().catch(()=>{}); };
        signal?.addEventListener('abort',onAbort,{once:true});
        await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) {
          const mode = await this.getWatchMode();
          await mode.apply(this.page);
          if (mode.state().silent) {
            await mode.applyBrowser(this.browser, { minimize: true });
          }
        }
        await this.checkVideoLimits(name);
        if(this.limitsEnabled && !this.limits().state().allowed) await this.pauseForLimits();
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com') {
          return this.page.evaluate(readPageState);
        }
        if (name==='douyin_open') await this.navigate(RECOMMEND,signal);
        if (name==='douyin_search') await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);
        if (name==='douyin_open_video') {
          if (args.url) await this.navigate(`https://www.douyin.com/video/${/\/video\/(\d+)/.exec(args.url)[1]}`,signal);
          else {
            const before = await this.state();
            const result = before.searchResults.find(item=>item.index===args.index);
            if (!result) throw new Error('这个 index 不在当前可见搜索结果内，请重新搜索。');
            const card = result.id ? this.page.locator(`[id="waterfall_item_${result.id}"] .search-result-card`) : this.page.locator('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]').filter({visible:true}).nth(args.index);
            if(await card.count()) { await card.click(); await this.settle(signal,{kind:'video',videoId:result.id}); }
            else if(result.url) await this.navigate(result.url,signal);
            else throw new Error('搜索结果卡片已变化，请重新搜索。');
          }
        }
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal,{recordLearning:!autonomousRunId,expectedVideoId});
        if (name==='douyin_play'||name==='douyin_pause') {
          await (await this.currentVideo()).evaluate(async(video, play)=>{ if(play) await video.play();else video.pause(); },name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') return await this.capture(name==='douyin_observe'?args.seconds??3:0,signal,{recordLearning:!autonomousRunId});
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal);
        aborted(signal);
        return this.state();
      } finally { signal?.removeEventListener('abort',onAbort); release(); }
      } finally { await releaseNativeLease?.(); }
    });
    this.queue=operation; return operation;
  }
  async currentVideo() {
    const index = await this.page.locator('video').evaluateAll(videos=>videos.map((video,index)=>{
      const r=video.getBoundingClientRect(),style=getComputedStyle(video);
      let painted=style.display!=='none'&&style.visibility!=='hidden'&&!video.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]');
      for(let node=video;node&&painted;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)painted=false;
      return {index,area:painted?Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)):0};
    }).filter(item=>item.area>0).sort((a,b)=>b.area-a.area)[0]?.index);
    if(index===undefined) throw new Error('没有在视口内找到视频。');
    return this.page.locator('video').nth(index);
  }
  async switchVideo(direction,signal,{recordLearning=true,expectedVideoId}={}) {
    if(![-1,1].includes(direction))throw new TypeError('换片方向须为上一条或下一条。');
    if(expectedVideoId!==undefined&&(typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))throw new TypeError('预期作品ID须为纯数字字符串。');
    const blocked=state=>state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage;
    const identity=state=>{
      if(blocked(state)||state.videoSelection?.ambiguous||state.videoSelection?.candidateCount>1)return null;
      if(typeof state.video?.id==='string'&&/^\d{1,64}$/.test(state.video.id)&&state.video.readyState>=2)return `video:${state.video.id}`;
      if(state.pageKind==='live-preview'&&state.livePreview?.recognized===true&&/^\d{4,30}$/.test(state.livePreview.roomId||''))return `live:${state.livePreview.roomId}`;
      return null;
    };
    let before,previousIdentity=null,stableSamples=0,beforeIdentity=null;
    for(let attempt=0;attempt<18;attempt++){
      aborted(signal);before=await this.state();
      if(blocked(before))return{changed:false,before:before.video,after:before.video,state:before,reasonCode:'switch-blocked'};
      const currentIdentity=identity(before);stableSamples=currentIdentity&&currentIdentity===previousIdentity?stableSamples+1:currentIdentity?1:0;
      previousIdentity=currentIdentity;
      if(stableSamples>=2){beforeIdentity=currentIdentity;break;}
      if(attempt<17)await wait(300,signal);
    }
    if(!beforeIdentity)return{changed:false,before:before?.video,after:before?.video,state:before,reasonCode:'video-identity-not-ready'};
    const beforeLive=beforeIdentity.startsWith('live:');
    if(expectedVideoId!==undefined){
      if(beforeLive)return{changed:false,before:before.video,after:before.video,state:before,expectedVideoId,reasonCode:'expected-video-unavailable'};
      if(before.video.id!==expectedVideoId)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',expectedVideoId,before:before.video,after:before.video,state:before};
    }
    let skipEvidenceId=null;
    if(recordLearning && direction>0 && before.video?.id && this.lastObservationVideoId===before.video.id && this.lastObservationEvidenceId && this.lastObservationState?.video?.id===before.video.id) {
      const wallSeconds=(Date.now()-this.lastObservationAt)/1000;
      if(Number.isFinite(wallSeconds) && wallSeconds>0 && wallSeconds<=30) {
        try {
          const viewing=this.getPersonaMemory().recordViewing?.({evidenceId:this.lastObservationEvidenceId,from:this.lastObservationState,to:before,wallSeconds,sampleId:randomUUID()},{source:this.source});
          if(viewing?.accepted===true) skipEvidenceId=this.lastObservationEvidenceId;
        }catch{/* 不能核实等待期间的进度时不补记快划偏好，换片仍按原操作执行。 */}
      }
    }
    const arrow=this.page.locator(`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`).filter({visible:true});
    let inputDenied=null;
    const denied=(state,reasonCode)=>({changed:false,before:state.video,after:state.video,state,reasonCode});
    const checkPendingInput=async()=>{
      aborted(signal);await this.checkVideoLimits(direction>0?'douyin_next':'douyin_previous');aborted(signal);
      const current=await this.state(),currentIdentity=identity(current);
      if(blocked(current)){inputDenied=denied(current,'switch-blocked');return false;}
      if(currentIdentity!==beforeIdentity){
        if(expectedVideoId!==undefined&&currentIdentity?.startsWith('video:')&&current.video.id!==expectedVideoId){
          await wait(300,signal);await this.checkVideoLimits(direction>0?'douyin_next':'douyin_previous');const confirmed=await this.state();
          inputDenied=identity(confirmed)===currentIdentity?{...denied(confirmed,'observed-video-changed'),staleObservation:true,expectedVideoId}:denied(confirmed,'video-changed-before-input');
        }else inputDenied=denied(current,'video-changed-before-input');
        return false;
      }
      before=current;return true;
    };
    if(!await checkPendingInput())return inputDenied;
    const arrowCount=await arrow.count();
    if(arrowCount>1)return denied(before,'switch-control-ambiguous');
    const control=arrowCount===1?arrow.first():null,token=`video-switch-${randomUUID()}`;
    const sameGeometry=(left,right)=>Boolean(left&&right&&['x','y','width','height'].every(key=>Math.abs(left[key]-right[key])<=0.5));
    const readPoint=async()=>{
      if(control){
        if(await arrow.count()!==1||!await control.isVisible()||!await control.isEnabled())return null;
        return control.evaluate((element,currentToken)=>{
          if(element.getAttribute('data-deepseek-switch-token')!==currentToken||element.closest('[disabled],[aria-disabled="true"]'))return null;
          const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
          if(r.width<2||r.height<2||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit!==element&&!element.contains(hit))return null;
          return{x:r.x,y:r.y,width:r.width,height:r.height,clickX:x,clickY:y};
        },token);
      }
      const box=before.video?.viewport||before.livePreview?.viewport;
      if(!box||box.width<2||box.height<2)return null;
      return this.page.evaluate(rect=>{
        const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);
        if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"],#captcha_container')||!hit.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]'))return null;
        return{...rect,clickX:x,clickY:y};
      },box);
    };
    const installInputGuard=({currentToken,expectedIdentity,selector})=>{
      const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
      const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
      const workId=value=>{try{const url=new URL(value,location.href);return /\/video\/(\d+)/.exec(url.pathname)?.[1]||url.searchParams.get('modal_id')||url.searchParams.get('aweme_id');}catch{return null;}};
      const currentIdentity=()=>{
        const videos=[...document.querySelectorAll('video')].filter(video=>{if(!visible(video)||video.closest(privateArea))return false;for(let node=video;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;return true;});
        if(videos.length>1)return null;
        const video=videos[0];
        if(video){
          const active=video.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');let root=active;
          if(!root){root=video.parentElement;for(let i=0;root?.parentElement&&i<8;i++){if(root.querySelector('[class*="video-info-detail"]'))break;root=root.parentElement;}}
          const playerId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(video.closest('[data-e2e="player-container"]')?.className??'')?.[1],activeId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(active?.className??'')?.[1];
          if(playerId&&activeId&&playerId!==activeId)return null;
          const id=playerId||activeId||[...(root?.querySelectorAll('a[href]')??[])].filter(link=>visible(link)&&!link.closest(privateArea)).map(link=>workId(link.href)).find(Boolean)||workId(location.href);
          if(id)return video.readyState>=2&&/^\d{1,64}$/.test(id)?`video:${id}`:null;
        }
        const route=new URL(location.href);if(!['/','/recommend','/recommend/'].includes(route.pathname)||workId(route.href))return null;
        const cards=[...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(card=>visible(card)&&!card.closest(privateArea));if(cards.length!==1)return null;
        const rooms=[...new Set([...cards[0].querySelectorAll('a[href]')].filter(visible).flatMap(link=>{try{const url=new URL(link.href);const id=url.origin==='https://live.douyin.com'?/^\/(\d{4,30})\/?$/.exec(url.pathname)?.[1]:null;return id?[id]:[];}catch{return[];}}))];
        return rooms.length===1?`live:${rooms[0]}`:null;
      };
      const entries=window.__deepseekVideoSwitchInputs??=Object.create(null),elements=selector?[...document.querySelectorAll(selector)].filter(visible):[],element=elements.length===1?elements[0]:null;
      if(selector&&!element)throw new Error('换片控件已变化，未安装输入核对。');
      const entry={armed:false,dispatched:false,blocked:false};if(element)element.setAttribute('data-deepseek-switch-token',currentToken);
      const types=element?['pointerdown','mousedown','mouseup','click']:['wheel'];
      const listener=event=>{
        if(!entry.armed||!event.isTrusted)return;
        if(entry.expired){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();if(event.type===(element?'click':'wheel')){entry.armed=false;entry.cleanup();delete entries[currentToken];}return;}
        const target=event.target instanceof Element?event.target:null,targetMatches=element?target&&(target===element||element.contains(target)):target?.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]');
        const protectedPage=[...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],[data-e2e="im-dialog"]')].some(visible)||[...document.querySelectorAll('body *')].some(node=>!node.childElementCount&&visible(node)&&!node.closest(privateArea)&&/扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent||''));
        if(!targetMatches||protectedPage||currentIdentity()!==expectedIdentity){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();return;}
        if(event.type===(element?'click':'wheel')){entry.dispatched=true;entry.armed=false;}
      };
      for(const type of types)document.addEventListener(type,listener,{capture:true,passive:false});
      entry.cleanup=()=>{clearTimeout(entry.timer);for(const type of types)document.removeEventListener(type,listener,true);if(element?.getAttribute('data-deepseek-switch-token')===currentToken)element.removeAttribute('data-deepseek-switch-token');};
      entries[currentToken]=entry;
    };
    try{
      await this.page.evaluate(installInputGuard,{currentToken:token,expectedIdentity:beforeIdentity,selector:control?`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`:null});
      let stablePoint,previousPoint,geometrySamples=0;
      const deadline=performance.now()+4000;
      while(performance.now()<deadline){
        if(!await checkPendingInput())return inputDenied;
        const point=await readPoint();geometrySamples=sameGeometry(point,previousPoint)?geometrySamples+1:point?1:0;previousPoint=point;
        if(geometrySamples>=3){stablePoint=point;break;}
        await wait(75,signal);
      }
      if(!stablePoint)return denied(before,'switch-control-not-interactable');
      if(!await checkPendingInput())return inputDenied;
      const finalPoint=await readPoint();if(!sameGeometry(stablePoint,finalPoint))return denied(before,'switch-control-changed');
      aborted(signal);
      const armInput=()=>this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];if(!entry)return false;entry.armed=true;entry.timer=setTimeout(()=>{entry.expired=true;},1500);return true;},token);
      if(control){
        if(!await armInput())return denied(before,'switch-control-changed');
        aborted(signal);
        await this.page.mouse.click(finalPoint.clickX,finalPoint.clickY);
      }else{
        await this.page.mouse.move(finalPoint.clickX,finalPoint.clickY);
        if(!await checkPendingInput())return inputDenied;
        const wheelPoint=await readPoint();if(!sameGeometry(finalPoint,wheelPoint))return denied(before,'switch-control-changed');
        if(!await armInput())return denied(before,'switch-control-changed');
        aborted(signal);await this.page.mouse.wheel(0,direction*700);
      }
      const receipt=await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];return{blocked:entry?.blocked===true,dispatched:entry?.dispatched===true};},token);
      if(receipt.blocked){if(!await checkPendingInput())return inputDenied;return denied(before,'switch-input-blocked');}
      if(!receipt.dispatched){if(!await checkPendingInput())return inputDenied;return denied(before,'switch-input-unconfirmed');}
    }finally{
      await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];entry?.cleanup();if(window.__deepseekVideoSwitchInputs)delete window.__deepseekVideoSwitchInputs[currentToken];},token).catch(()=>{});
    }
    let after=before,afterIdentity=null,previousAfter=null,readySamples=0;
    // 一次输入后只回读，不在加载慢或身份暂缺时重复点击，避免连续跳过多条。
    for(let i=0;i<40;i++) {
      await wait(300,signal); after=await this.state();
      if(blocked(after))break;
      const currentIdentity=identity(after),different=currentIdentity&&currentIdentity!==beforeIdentity;
      readySamples=different?currentIdentity===previousAfter?readySamples+1:1:0;previousAfter=different?currentIdentity:null;
      if(readySamples>=2){afterIdentity=currentIdentity;break;}
    }
    const changed=Boolean(afterIdentity&&afterIdentity!==beforeIdentity);
    if(skipEvidenceId && changed && after.video?.id && after.video.id!==before.video?.id && after.video.readyState>=2) {
      try {this.getPersonaMemory().recordBehavior?.({evidenceId:skipEvidenceId,action:'skip',sampleId:randomUUID(),confirmed:true},{source:this.source});}catch{/* 学习失败不改变已确认的切片结果。 */}
    }
    return {changed,before:before.video,beforePageKind:before.pageKind,after:after.video,state:after,...(!changed?{reasonCode:blocked(after)?'switch-blocked':'switch-not-confirmed'}:{})};
  }
  async capture(seconds,signal,{recordLearning=true}={}) {
    const captureStarted=Date.now();
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(state.livePreview?.recognized === true) return {state,frames:[],note:'当前是推荐流直播预览，不采集直播画面。'};
    if(!state.video) return {state,frames:[],note:'没有可见视频画面，请先打开作品。'};
    const frames=[],samples=seconds?3:1;
    const before={...state.video}, firstState=structuredClone(state);
    let sampledState=state,sampledAt=captureStarted,stoppedReason=null;
    for(let index=0;index<samples;index++) {
      aborted(signal);
      if(index) await wait(seconds*1000/(samples-1),signal);
      state=await this.state();
      await this.checkVideoLimits('douyin_observe');
      if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible||state.livePreview?.recognized === true) return {state,frames:[],note:'出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。'};
      if(state.video?.id!==before.id) {stoppedReason='采样期间切换作品，保留的画面只属于此前作品。';break;}
      const {x,y,width,height}=state.video.viewport;
      if(width<2||height<2) break;
      // 采样保留动画和光标，避免截图期间改写播放器页面的样式。
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},animations:'allow',caret:'initial',timeout:10_000});
      aborted(signal);
      const checked=await this.state();
      if(checked.loginRequired||checked.verificationRequired||checked.unsupportedPage||checked.privateChatVisible||checked.livePreview?.recognized === true) return {state:checked,frames:[],note:'截图期间出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。'};
      if(checked.video?.id!==before.id) {stoppedReason='截图期间切换作品，本帧已丢弃。';break;}
      frames.push({mimeType:'image/jpeg',data:data.toString('base64'),time:state.video.time,videoId:state.video.id});
      sampledState=checked;sampledAt=Date.now();
    }
    const result={state:sampledState,frames,observation:{seconds,videoId:before.id,stoppedReason,beforeTime:before.time,beforePaused:before.paused,afterTime:sampledState.video?.time,paused:sampledState.video?.paused,
      note:'采集的是实际视频视口画面；没有音频，只能说明这些采样时刻。'}};
    if (frames.length && ['api','dsh'].includes(this.source)) {
      try {
        const persona=this.getPersonaMemory(),origin={source:this.source};
        result.personaEvidenceId=persona.recordObservation(result,{...origin,kind:'visual'}).evidenceId;
        const wallSeconds=(sampledAt-captureStarted)/1000,sampleId=randomUUID();
        if(persona.recordViewing && wallSeconds<=30) {
          result.viewing={evidenceId:result.personaEvidenceId,sampleId,...persona.recordViewing({evidenceId:result.personaEvidenceId,from:firstState,to:sampledState,wallSeconds,sampleId},origin)};
          if(recordLearning && this.lastObservationVideoId===before.id && result.viewing.creditedSeconds>0) persona.recordBehavior?.({evidenceId:result.personaEvidenceId,action:'stay',sampleId,confirmed:true},origin);
        }
        this.lastObservationVideoId=before.id;this.lastObservationEvidenceId=result.personaEvidenceId;
        this.lastObservationState=structuredClone(sampledState);this.lastObservationAt=sampledAt;
      }
      catch { result.personaWarning='本次画面未登记为兴趣证据，不能据此更新人格兴趣。'; }
    }
    return result;
  }
  async captureAudio(seconds,signal) {
    await this.checkVideoLimits('douyin_listen');
    const before=await this.state({record:false});
    if(before.loginRequired||before.verificationRequired||before.privateChatVisible||!before.video?.id) throw new Error('当前没有可录取的公开作品，或登录、验证、私信面板遮挡页面。');
    const result=await (await this.currentVideo()).evaluate(async(video,seconds)=>{
      if(typeof video.captureStream!=='function' || typeof MediaRecorder==='undefined') throw new Error('浏览器没有提供当前视频的可用音轨采集接口。');
      const wasPaused=video.paused; await video.play();
      const stream=video.captureStream();
      const tracks=stream.getAudioTracks().map(track=>track.clone());
      if(!tracks.length) {if(wasPaused)video.pause();throw new Error('当前作品没有向浏览器暴露可采集音轨，未录取其他声音。');}
      const audio=new MediaStream(tracks),chunks=[];
      const mimeType=['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType) {tracks.forEach(track=>track.stop());if(wasPaused)video.pause();throw new Error('浏览器不支持音轨录取格式。');}
      try {
        const recorder=new MediaRecorder(audio,{mimeType,audioBitsPerSecond:64000});
        await new Promise((resolve,reject)=>{
          let size=0; const timer=setTimeout(()=>recorder.state!=='inactive'&&recorder.stop(),seconds*1000);
          recorder.ondataavailable=event=>{size+=event.data.size;if(size>2_000_000){clearTimeout(timer);recorder.stop();reject(new Error('音轨超过2MB采集预算。'));}else chunks.push(event.data);};
          recorder.onerror=()=>{clearTimeout(timer);reject(new Error('当前视频音轨采集失败。'));};
          recorder.onstop=()=>{clearTimeout(timer);resolve();};recorder.start(250);
        });
        const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());
        if(!bytes.length) throw new Error('当前音轨没有生成可用数据。');
        let encoded='';for(let offset=0;offset<bytes.length;offset+=32768) encoded+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
        return {data:btoa(encoded),mimeType,bytes:bytes.length};
      }finally{tracks.forEach(track=>track.stop());if(wasPaused)video.pause();}
    },seconds);
    aborted(signal);await this.checkVideoLimits('douyin_listen');
    const after=await this.state({record:false});
    if(after.loginRequired||after.verificationRequired||after.privateChatVisible||after.unsupportedPage||after.video?.id!==before.video.id) throw new Error('录音期间页面或作品身份改变，音轨已丢弃。');
    return {...result,videoId:before.video.id,beforeTime:before.video.time,afterTime:after.video.time,seconds,state:after};
  }
  async listen(seconds,signal) {
    const media=await this.getMediaAdapter(),settings=await media.settings();
    if(!settings.enabled) return {ok:true,audioAvailable:false,note:'音频能力默认关闭，请由用户在本机控制台选择开启。'};
    const captured=await this.captureAudio(seconds,signal);
    const directory=resolveRuntimePaths().mediaCaptureDir;mkdirSync(directory,{recursive:true});
    const target=path.join(directory,`${randomUUID()}.webm`);writeFileSync(target,Buffer.from(captured.data,'base64'));
    try {
      const result=await media.transcribeAudio({source:target,backend:settings.backend,durationSeconds:seconds},{signal});
      return {ok:true,audioAvailable:result.ok===true,state:captured.state,audio:{...result,videoId:captured.videoId,beforeTime:captured.beforeTime,afterTime:captured.afterTime,seconds},note:'只采集当前视频这一小段实际音轨；转写不能代替音乐或环境声理解。'};
    }finally{try{unlinkSync(target);}catch{}}
  }
  async close() {
    this.cancelLimitsWatch?.(); this.cancelLimitsWatch=null;
    if(this.limitsEnabled) await this.pauseForLimits();
    await this.queue.catch(()=>{});
    await this.browser?.close().catch(()=>{});
    if(this.sparkPromise) await this.sparkPromise.then(spark=>spark.close()).catch(()=>{});
    if(this.commentsPromise) await this.commentsPromise.then(comments=>comments.close()).catch(()=>{});
    if(this.commenterPromise) await this.commenterPromise.then(commenter=>commenter.close?.()).catch(()=>{});
    if(this.chatPromise) await this.chatPromise.then(chat=>chat.close()).catch(()=>{});
    if(this.forwarderPromise) await this.forwarderPromise.then(forwarder=>forwarder.close?.()).catch(()=>{});
    this.memory?.close(); this.browser=null; this.page=null; this.memory=null;
  }
}
