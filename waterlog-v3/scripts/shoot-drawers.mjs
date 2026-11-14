#!/usr/bin/env node
/**
 * 跨页抽屉验证：证明「点一下就出抽屉」不只是在某一张页面上跑通。
 *
 * 为什么需要这个脚本：抽屉是共享组件，但**触发它的每一处接线是各页自己写的**。
 * 组件单测再绿也证明不了 `/shift` 的站名按钮真的调到了 `setSiteId`——
 * 只有真点一次、再把抽屉里的文本读回来才算数。
 *
 * 三条写探针时用血换来的规矩：
 *   1. 靠形状找元素会找出同形状的别的东西 —— 必须给它一个名字（`data-drawer`）。
 *      （本脚本第一版用「最后一个宽度 >200 的 <aside>」找抽屉，抓到的却是侧栏导航，
 *       报告写着「抽屉 212px · 内涝预测预警」——数字像成功了，其实一个抽屉都没开。）
 *   2. 「找不到」和「看不见」是两件事 —— 先把候选滚进视口再量坐标。
 *   3. 页面坏了会静默给出「找不到元素」这种假象 —— 求值异常要抛出来，别吞。
 *
 * 数据：这个脚本自带注雨（`POST /api/sim/storm`）。原因是 `/shift` 只显示
 * 「本班 12 小时窗口内升起的预警」，雨停了这页就是空的——那是对的，不是坏的。
 * 但空页面会让用例报 FAIL，假的红灯一旦亮起来，人就开始忽略这条路。
 * 自己造数据比放宽断言可靠。不想注雨时加 `--no-storm`。
 *
 * 用法：node scripts/shoot-drawers.mjs
 *       node scripts/shoot-drawers.mjs --no-storm
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
const HEIGHT = Number(arg('height', 1000));
const WAIT = Number(arg('wait', 3400));
const PORT = Number(arg('port', 9346));
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

async function evaluate(cdp, sid, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.exceptionDetails) {
    throw new Error(
      `页面求值异常：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`,
    );
  }
  return r.result?.value;
}

async function clickAt(cdp, sid, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid);
  await sleep(200);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    sid,
  );
  await sleep(70);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    sid,
  );
}

/** 把候选滚进视口中央，再量出可点坐标。 */
const locate = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return {
    x: Math.round(r.left + Math.min(160, Math.max(40, r.width / 3))),
    y: Math.round(r.top + r.height / 2),
    text: String(el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || '',
  };
})()`;

/** 读回抽屉：它是哪一个、多宽、里面五节齐不齐。按名字找，不按形状找。 */
const READ_DRAWER = `(() => {
  const a = document.querySelector('[data-drawer="site"]');
  if (!a) return { open: false };
  const txt = String(a.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  return {
    open: true,
    width: Math.round(a.getBoundingClientRect().width),
    title: txt[0] || '',
    sub: txt[1] || '',
    canvas: a.querySelectorAll('canvas').length,
    grip: !!a.querySelector('[role="separator"]'),
    sections: txt.filter((t) => ['四级阈值距离', '水位走势与预测', '模型预测', '同街道对照', '操作'].includes(t)),
    head: txt.slice(0, 8),
  };
})()`;

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const cookies = await login();
  console.log(`  已登录 ${USER}`);

  const profile = path.join(process.env.TEMP || '.', `wl-dr-${PORT}`);
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
  const report = [];
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
    await cdp.send('Runtime.enable', {}, sid);
    for (const c of cookies) {
      await cdp.send('Network.setCookie', { name: c.name, value: c.value, url: BASE }, sid);
    }
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
      sid,
    );

    const go = async (route) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${BASE}${route}` }, sid);
      await Promise.race([loaded, sleep(15000)]);
      await sleep(WAIT);
    };
    const shot = async (name, note) => {
      const { data } = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        sid,
      );
      const buf = Buffer.from(data, 'base64');
      await writeFile(path.join(OUT, `${name}.png`), buf);
      console.log(`  ${name.padEnd(24)} ${(buf.length / 1024).toFixed(1)}KB  ${note}`);
    };

    const cases = [
      { route: '/sites', name: 'drawer-sites', note: '站点表：点一行就地开抽屉', sel: 'tr[data-site-row]' },
      { route: '/alerts', name: 'drawer-alerts', note: '预警页：点站名开抽屉（点行仍是选预警）', sel: 'button[data-site-name]' },
      { route: '/shift', name: 'drawer-shift', note: '值班台：交接事项里点站名开抽屉', sel: 'button[data-site-name]' },
      { route: '/model', name: 'drawer-model', note: '模型页：决策日志里点站名开抽屉', sel: 'tr[data-site-row]' },
    ];

    // 先造数据：值班台与预警页只看「本班窗口内升起的预警」，雨停了它们就该是空的。
    // 空不是坏，但会让用例报 FAIL —— 假红灯比没有红灯更糟，所以自己造。
    if (!argv.includes('--no-storm')) {
      // 用 Node 直接发，不要在浏览器里 fetch：
      // 此刻页面还是 about:blank，相对 /api 解析不了；换成绝对地址又变成
      // 从 opaque origin 发起跨源请求（对方没有 CORS 头），只会得到
      // `Failed to fetch` —— 而它的表现和「接口挂了」一模一样。
      // 登录 cookie 已经在 cookies 里，原样带上即可。
      const jar = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const sr = await fetch(`${BASE}/api/sim/storm?peak=228&dur=48`, {
        method: 'POST',
        headers: { Cookie: jar },
      });
      const seeded = await sr.text();
      console.log(`  注雨：HTTP ${sr.status} ${seeded.slice(0, 160)}`);
      if (!sr.ok || !seeded.includes('"ok":true')) {
        // 注雨失败就别再等 200 秒了 —— 等下去也等不来数据，只会把
        // 「注雨接口坏了」伪装成「值班台没有数据行」。
        throw new Error(`注雨失败：HTTP ${sr.status} ${seeded.slice(0, 200)}`);
      }
      // 等水位真的涨上来。写死「等 118 秒」是猜的——仿真时钟一改就失效，
      // 而失效的表现是「用例报没有数据行」，看起来像组件坏了。改成轮询实测值。
      const capMs = Number(arg('storm-wait', 200000));
      const t0 = Date.now();
      let maxDepth = 0;
      while (Date.now() - t0 < capMs) {
        await sleep(5000);
        const ovr = await fetch(`${BASE}/api/overview`, { headers: { Cookie: jar } });
        if (ovr.ok) {
          const j = await ovr.json();
          maxDepth = (j.sites || []).reduce((m, x) => Math.max(m, Number(x.depth) || 0), 0);
        }
        if (maxDepth >= 0.5) break;
      }
      console.log(`  等 ${Math.round((Date.now() - t0) / 1000)}s，最深积水 ${maxDepth.toFixed(2)} m`);
    }

    for (const c of cases) {
      // 每例从默认宽度起步：抽屉宽度记在 localStorage，上一例拖到 760 之后
      // 这一例的「拖宽」就永远测不出变化 —— 那是**上一例的副作用**，不是这一例的失败。
      await evaluate(cdp, sid, `try { window.localStorage.removeItem('wl-drawer-w') } catch (e) {}`);
      await go(c.route);
      await shot(`${c.name}-00-before`, `${c.note} · 改前（未点）`);

      let target = await evaluate(cdp, sid, locate(c.sel));
      if (!target && c.route === '/alerts') {
        // 预警页默认只看「激活中」。那一刻恰好没有激活中的预警时表格是空的，
        // 这不是选择器失效，是没数据 —— 切到「全部历史」再找一次。
        const tab = await evaluate(
          cdp,
          sid,
          `(() => {
             const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '全部历史');
             if (!b) return null;
             b.click();
             const r = b.getBoundingClientRect();
             return { x: 1, y: 1, text: '全部历史' };
           })()`,
        );
        if (tab) {
          await sleep(1200);
          target = await evaluate(cdp, sid, locate(c.sel));
        }
      }
      if (!target) {
        const rows = await evaluate(cdp, sid, `document.querySelectorAll('tbody tr').length`);
        report.push(
          `${c.route} —— FAIL ${rows === 0 ? '页面上没有数据行（不是选择器问题）' : `找不到 ${c.sel}`}`,
        );
        console.log(`  !! ${c.route} 找不到 ${c.sel}（当前 tbody tr = ${rows}）`);
        continue;
      }

      await clickAt(cdp, sid, target.x, target.y);
      await sleep(1500);
      const d = await evaluate(cdp, sid, READ_DRAWER);
      await shot(
        `${c.name}-01-open`,
        `点「${target.text}」→ ${d.open ? `抽屉 ${d.width}px「${d.title}」` : '没有抽屉'}`,
      );
      report.push(
        `${c.route} —— ${
          d.open
            ? `OK 抽屉 ${d.width}px · ${d.title} · canvas ${d.canvas} · 节 ${d.sections.join('/')}`
            : 'FAIL 没打开'
        }`,
      );

      // 拖左边缘：宽度应变大且被记住
      const grip = await evaluate(
        cdp,
        sid,
        `(() => {
           const a = document.querySelector('[data-drawer="site"]');
           if (!a) return null;
           const g = a.querySelector('[role="separator"]');
           if (!g) return { noGrip: true };
           const gr = g.getBoundingClientRect();
           return { x: Math.round(gr.left + gr.width / 2), y: Math.round(gr.top + gr.height / 2), w: Math.round(a.getBoundingClientRect().width) };
         })()`,
      );
      if (grip && !grip.noGrip) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y, button: 'none' }, sid);
        await sleep(150);
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1 },
          sid,
        );
        for (let i = 1; i <= 6; i++) {
          await cdp.send(
            'Input.dispatchMouseEvent',
            { type: 'mouseMoved', x: grip.x - i * 18, y: grip.y, button: 'left', buttons: 1 },
            sid,
          );
          await sleep(45);
        }
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: grip.x - 108, y: grip.y, button: 'left', clickCount: 1 },
          sid,
        );
        await sleep(600);
        const d2 = await evaluate(cdp, sid, READ_DRAWER);
        await shot(`${c.name}-02-wider`, `拖左边缘 ${grip.w}px → ${d2.width}px`);
        report.push(
          `   ↳ 拖宽 ${grip.w} → ${d2.width}px ${d2.width > grip.w + 60 ? 'OK' : 'FAIL（没变宽）'}`,
        );
        const stored = await evaluate(cdp, sid, `window.localStorage.getItem('wl-drawer-w')`);
        report.push(`   ↳ localStorage wl-drawer-w = ${stored}`);
      } else {
        report.push('   ↳ FAIL 没有拖拽把手');
      }
    }

    // 术语气泡：不懂的词悬停 220ms 就该有解释
    await go('/model');
    const term = await evaluate(
      cdp,
      sid,
      `(() => {
         const all = [...document.querySelectorAll('span[tabindex="0"]')];
         const t = all.find((s) => String(s.innerText || '').trim() === 'skill') || all[0];
         if (!t) return null;
         t.scrollIntoView({ block: 'center', behavior: 'instant' });
         const r = t.getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: String(t.innerText || '').trim() };
       })()`,
    );
    if (term) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: term.x, y: term.y, button: 'none' }, sid);
      await sleep(1000);
      const tip = await evaluate(
        cdp,
        sid,
        `(() => {
           const t = document.querySelector('[role="tooltip"]');
           return t ? { ok: true, text: String(t.innerText || '').replace(/\\n/g, ' | ').slice(0, 160) } : { ok: false };
         })()`,
      );
      await shot('tip-01-glossary', `悬停「${term.text}」→ ${tip.ok ? '气泡已出' : '没有气泡'}`);
      report.push(`术语气泡 —— ${tip.ok ? `OK ${tip.text}` : 'FAIL 没浮出'}`);
    } else {
      report.push('术语气泡 —— FAIL 页面上找不到词');
    }

    console.log('\n—— 结果 ——');
    for (const line of report) console.log('  ' + line);
    if (report.some((r) => /FAIL|找不到/.test(r))) exit = 1;
  } catch (e) {
    console.error('失败：', e.message);
    exit = 1;
  } finally {
    child.kill();
  }
  process.exit(exit);
};

main();
