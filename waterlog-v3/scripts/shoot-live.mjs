#!/usr/bin/env node
/**
 * 交互截图：把「点一下会发生什么」拍下来。
 *
 * 与 `shoot.mjs` 的区别：那个只导航再抓图，证明不了交互。
 * 这个走 CDP 的 `Input.dispatchMouseEvent`，真的去点列表行、点按钮，
 * 每步之间等动画落定，然后抓图——**截图里看到的 drawer 是真点出来的**。
 *
 * 用法：
 *   node scripts/shoot-live.mjs
 *   node scripts/shoot-live.mjs --base http://127.0.0.1:8200 --wait 3500
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = arg('base', 'http://127.0.0.1:8200');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin123');
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 950));
const WAIT = Number(arg('wait', 4200));
const PORT = Number(arg('port', 9344));
const OUT = path.resolve(ROOT, arg('out', 'shots'));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome/Edge');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`连不上 ${url}`);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) for (const fn of this.listeners) fn(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(p));
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
      const fn = (m) => {
        if (m.method === method) {
          this.listeners.delete(fn);
          resolve(m.params);
        }
      };
      this.listeners.add(fn);
    });
  }
}

/** 在页面里求值，返回 JSON。用于找元素的屏幕坐标。 */
async function evaluate(cdp, sid, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面求值失败');
  return r.result?.value;
}

/** 真的用鼠标点：先移动（触发 hover）再按下抬起，中间留时间给 hover 动画。 */
async function clickAt(cdp, sid, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid);
  await sleep(260);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
  await sleep(70);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
}

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const cookies = await login();
  console.log(`  已登录 ${USER}`);

  const profile = path.join(process.env.TEMP || '.', `wl-live-${PORT}`);
  await rm(profile, { recursive: true, force: true });

  const child = spawn(
    CHROME,
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

  let exit = 0;
  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Network.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    for (const c of cookies) {
      await cdp.send('Network.setCookie', { name: c.name, value: c.value, url: BASE }, sid);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sid);

    const shot = async (name, note) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sid);
      const buf = Buffer.from(data, 'base64');
      await writeFile(path.join(OUT, `${name}.png`), buf);
      console.log(`  ${name.padEnd(26)} ${(buf.length / 1024).toFixed(1)}KB  ${note}`);
      return buf.length;
    };

    const go = async (route, extraWait = 0) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${BASE}${route}` }, sid);
      await Promise.race([loaded, sleep(15000)]);
      await sleep(WAIT + extraWait);
    };

    // ① 初始态：能看出左栏列表 + 地图 + 未选中
    await go('/live');
    await shot('live-01-idle', '空白态：列表 + 地图，无抽屉');

    // ② 点第一行（等级最高那站）→ 抽屉滑出 + 地图飞过去
    const row = await evaluate(cdp, sid, `(() => {
      const btns = [...document.querySelectorAll('button[data-site-row]')];
      if (!btns.length) return null;
      const r = btns[0].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 22), text: btns[0].innerText.split('\\n')[0] };
    })()`);
    if (!row) throw new Error('左栏没有站点行——是不是没数据？');
    await clickAt(cdp, sid, row.x, row.y);
    await sleep(1500);
    await shot('live-02-drawer', `点第一行「${row.text}」→ 抽屉 + 地图飞行`);

    // ③ 在抽屉开着的情况下点第三行 → 抽屉不关、内容原地切换
    const row3 = await evaluate(cdp, sid, `(() => {
      const btns = [...document.querySelectorAll('button[data-site-row]')];
      if (btns.length < 3) return null;
      const r = btns[2].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 22), text: btns[2].innerText.split('\\n')[0] };
    })()`);
    if (row3) {
      await clickAt(cdp, sid, row3.x, row3.y);
      await sleep(1500);
      await shot('live-03-switch', `抽屉开着时点「${row3.text}」→ 内容切换不闪`);
    }

    // ④ 切排序到「涨速」→ 列表重排（layout 动画）
    const seg = await evaluate(cdp, sid, `(() => {
      const t = [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent.trim() === '涨速');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (seg) {
      await clickAt(cdp, sid, seg.x, seg.y);
      await sleep(260);
      await shot('live-04-sort-mid', '排序切换动画进行中（滑块位移）');
      await sleep(900);
      await shot('live-05-sorted', '按涨速重排后的列表');
    }

    // ⑤ 只看预警 + 搜索
    const filt = await evaluate(cdp, sid, `(() => {
      const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '只看预警');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (filt) {
      await clickAt(cdp, sid, filt.x, filt.y);
      await sleep(700);
      await shot('live-06-alarmonly', '只看预警：地图与列表同步过滤');
    }

    // ⑥ hover 地图气泡（触发 Leaflet tooltip）——先滚到地图中心再移动鼠标
    const mapBox = await evaluate(cdp, sid, `(() => {
      const el = document.querySelector('.leaflet-container');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    const pin = await evaluate(cdp, sid, `(() => {
      const el = document.querySelector('.leaflet-container');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // 找画在视口内的气泡：遍历 svg path，取一个在中间区域的
      const paths = [...el.querySelectorAll('path.leaflet-interactive')];
      for (const p of paths) {
        const b = p.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        if (cx > r.left + 60 && cx < r.right - 60 && cy > r.top + 60 && cy < r.bottom - 60) {
          return { x: Math.round(cx), y: Math.round(cy) };
        }
      }
      return null;
    })()`);
    if (mapBox && pin) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pin.x, y: pin.y, button: 'none' }, sid);
      await sleep(900);
      await shot('live-07-hover', '悬停地图气泡 → 浮出站名/等级/雨强');
    }

    // ⑦ Esc 关抽屉
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
    await sleep(900);
    await shot('live-08-esc', '按 Esc 关闭抽屉');

    // ⑧ 窄屏（1366 笔记本）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, sid);
    await sleep(900);
    const r5 = await evaluate(cdp, sid, `(() => {
      const b = [...document.querySelectorAll('button[data-site-row]')][4];
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 22) };
    })()`);
    if (r5) {
      await clickAt(cdp, sid, r5.x, r5.y);
      await sleep(1600);
      await shot('live-09-narrow', '1366 窄屏：列表收起、抽屉盖住地图');
    }

    console.log(`\n输出目录：${OUT}`);
  } catch (err) {
    console.error('截图失败：', err.message);
    exit = 1;
  } finally {
    try { child.kill(); } catch {}
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exit);
};

main();
