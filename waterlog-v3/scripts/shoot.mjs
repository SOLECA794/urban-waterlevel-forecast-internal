#!/usr/bin/env node
/**
 * 逐页截图（Chrome DevTools Protocol）。
 *
 * 为什么不用 `chrome --screenshot`：那个开关在页面 load 事件后立刻抓图，
 * 前端还在 `加载中...` 就拍完了，而且 SSE 长连接会让 --virtual-time-budget 永远等不到 idle。
 * 走 CDP 就能「导航 → 等数据渲染 → 再抓图」，还能按需截整页。
 *
 * 用法：
 *   node scripts/shoot.mjs                        # 抓全部页面
 *   node scripts/shoot.mjs --only model           # 只抓名字里含 model 的
 *   node scripts/shoot.mjs --base http://127.0.0.1:8200 --wait 3500
 *   node scripts/shoot.mjs --user admin --pass admin123
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:8200');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin123');
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 1500));
const WAIT = Number(arg('wait', 3000));
const ONLY = arg('only', '');
const OUT = path.resolve(ROOT, arg('out', 'shots'));
const PORT = Number(arg('port', 9333));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chrome) {
  console.error('未找到 Chrome/Edge，无法截图');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`连不上 ${url}`);
}

/**
 * 登录拿会话 cookie。
 *
 * 接口加了鉴权之后，无 cookie 的浏览器只会被重定向到登录页，
 * 截出来的七张图全是同一个登录框——所以必须先登录、再把 cookie 灌进浏览器。
 * 这里用 fetch 而不是走页面表单：截图脚本不该依赖登录页的 DOM。
 */
async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`登录失败 HTTP ${res.status}：${text.slice(0, 160)}`);
  }
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookies = raw.map((line) => {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
  });
  if (cookies.length === 0) throw new Error('登录成功但响应里没有 Set-Cookie');
  return cookies;
}

/** 极简 CDP 客户端：一条 WebSocket 多路复用，按 id 匹配响应。 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }
  once(method) {
    return new Promise((resolve) => {
      const fn = (msg) => {
        if (msg.method === method) {
          this.listeners.delete(fn);
          resolve(msg.params);
        }
      };
      this.listeners.add(fn);
    });
  }
}

async function pickDetailSite(cookieHeader) {
  try {
    const res = await fetch(`${BASE}/api/overview`, { headers: { Cookie: cookieHeader } });
    const j = await res.json();
    // 字段是平铺的 warn_level / warn_score（api/internal/domain 的 OverviewSite），
    // 不是嵌套的 warning.level —— 按嵌套取会静默拿到 undefined，永远退到兜底站。
    const hot = (j.sites || [])
      .filter((s) => s.warn_level && s.warn_level !== 'none')
      .sort((a, b) => (b.warn_score || 0) - (a.warn_score || 0))[0];
    if (hot) return hot.site_id;
    const anySite = (j.sites || [])[0];
    if (anySite) return anySite.site_id;
  } catch {}
  return 'S08';
}

const main = async () => {
  await mkdir(OUT, { recursive: true });

  const cookies = await login();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  console.log(`  已登录 ${USER}，会话 cookie ${cookies.map((c) => c.name).join(',')}`);

  const profile = path.join(process.env.TEMP || '.', `wlshot-cdp-${PORT}`);
  await rm(profile, { recursive: true, force: true });

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--no-proxy-server',
      '--proxy-bypass-list=<-loopback>',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let exitCode = 0;
  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    const cdp = new CDP(ws);

    const detailSite = await pickDetailSite(cookieHeader);
    // 登录页排最后：它要 `Network.clearBrowserCookies` 才能截到「没登录」的样子，
    // 而 setCookie 写的是 profile 级 cookie、跨 target 共享，放在中间会把后面的页也踢成游客。
    let pages = [
      ['01-overview', '/'],
      ['02-sites', '/sites'],
      [`03-detail-${detailSite}`, `/sites/${detailSite}`],
      ['04-alerts', '/alerts'],
      ['05-shift', '/shift'],
      ['06-model', '/model'],
      ['07-rules', '/rules'],
      ['08-system', '/system'],
      ['09-admin', '/admin'],
      ['10-login', '/login'],
    ];
    if (ONLY) pages = pages.filter((p) => p[0].includes(ONLY));

    const results = [];
    for (const [name, route] of pages) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      try {
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Network.enable', {}, sessionId);
        // 登录页要截"没登录"的样子。光"不灌 cookie"不够：setCookie 写的是
        // 浏览器 profile 级 cookie，跨 target 共享，轮到 /login 时浏览器其实
        // 已经登录，前端按设计会跳回首页，截出来是一张图。
        if (name.includes('login')) {
          await cdp.send('Network.clearBrowserCookies', {}, sessionId);
        } else {
          for (const c of cookies) {
            await cdp.send('Network.setCookie', { name: c.name, value: c.value, url: BASE }, sessionId);
          }
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: WIDTH,
          height: HEIGHT,
          deviceScaleFactor: 1,
          mobile: false,
        }, sessionId);

        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: `${BASE}${route}` }, sessionId);
        await Promise.race([loaded, sleep(15000)]);
        // load 事件只是壳子加载完，React 还在拉 /api/*，必须再等一会儿。
        await sleep(WAIT);

        const { data } = await cdp.send(
          'Page.captureScreenshot',
          { format: 'png', fromSurface: true, captureBeyondViewport: true },
          sessionId,
        );
        const file = path.join(OUT, `${name}.png`);
        await writeFile(file, Buffer.from(data, 'base64'));
        const kb = (Buffer.from(data, 'base64').length / 1024).toFixed(1);
        console.log(`  ${name.padEnd(20)} ok  ${kb}KB  ${route}`);
        results.push({ name, route, bytes: Number(kb) * 1024 });
      } catch (err) {
        console.log(`  ${name.padEnd(20)} 失败  ${route}  ${err.message}`);
        results.push({ name, route, bytes: 0, error: err.message });
      } finally {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }

    await writeFile(
      path.join(OUT, 'index.json'),
      JSON.stringify({ base: BASE, width: WIDTH, height: HEIGHT, captured_at: new Date().toISOString(), pages: results }, null, 2),
      'utf8',
    );
    console.log(`\n输出目录：${OUT}`);
  } catch (err) {
    console.error('截图失败：', err.message);
    exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exitCode);
};

main();
