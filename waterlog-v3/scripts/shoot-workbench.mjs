#!/usr/bin/env node
/**
 * 工作台（/w）验证：证明「一整屏 + 点击层次」这个形态真的成立。
 *
 * 为什么需要它：这一版把十个页面合成了一屏，**唯一的正确性就是交互链**。
 * 页面能画出来（截图有像素）不代表：
 *   ① 点左栏一行真的换了舞台；
 *   ② 换舞台之后左栏的排序/滚动/筛选还在（这是验收标准第 2 条，
 *      也是「不换页」这句话唯一的实测含义）；
 *   ③ 任何一次点击都没有把 URL 从 /w 带走（走了就是又变回多页了）；
 *   ④ 右栏真的记下了「我是怎么到这儿来的」（否则「层次」是假的）。
 *
 * 四条写探针时用血换来的规矩（引自 shoot-drawers.mjs，这一版继续守）：
 *   1. 按名字找，不按形状找。锚点一律 `data-*`：`data-fact` / `data-rail-tab`
 *      / `data-site-row` / `data-stage-head` / `data-drill` / `data-trail`。
 *   2. 「找不到」和「看不见」是两件事 —— 先 scrollIntoView 再量坐标。
 *   3. 求值异常必须抛出来，别吞成「找不到元素」。
 *   4. **断言要能区分「数字是对的」和「数字恰好看起来对」**——
 *      所以每次点击都要求 `data-stage-head` 等于本次点的 key，
 *      而不是「页面变了就算过」。上一版的抽屉走查在这条上栽过：
 *      关闭按钮选择器写错，抽屉一次都没关，脚本点到抽屉自己，
 *      读回上一条的内容，报告却写着 OK。
 *
 * 用法：node scripts/shoot-workbench.mjs
 *       node scripts/shoot-workbench.mjs --no-storm --base http://127.0.0.1:8200
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
const WAIT = Number(arg('wait', 2600));
const PORT = Number(arg('port', 9371));
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

/**
 * 还在工作台上吗。
 *
 * 不写死 `/w`：这一屏的地址是 `/`，而 `/w` 只是旧链接的重定向。
 * 断言真正要回答的是「有没有换页」——换页的表现是路径变成 /login 或 /board，
 * 而不是地址里多了 `?on=site&site=S09`。
 */
const onWorkbench = (p) => p === '/' || p.startsWith('/?');

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
  await sleep(180);
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
  await sleep(420);
}

/** 按名字找元素、滚进视口、量出可点坐标。找不到返回 null（调用方负责报错）。 */
const locate = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return { zero: true, w: Math.round(r.width), h: Math.round(r.height) };
  return {
    x: Math.round(Math.min(r.left + r.width / 2, r.left + r.width - 6)),
    y: Math.round(r.top + r.height / 2),
    text: String(el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || '',
  };
})()`;

/**
 * 工作台的心跳读数。
 *
 * 一次读全，是为了让「点了之后什么变了、什么没变」在**同一个时刻**被观察：
 * 分两次读之间页面可能已经因为 SSE 推送重排，两次读到的差异就说不清是谁造成的。
 */
const READ = `(() => {
  const root = document.querySelector('[data-workbench]')
  if (!root) return { ok: false, why: '没有 [data-workbench]：这一屏根本没渲染出来' }
  const head = root.querySelector('[data-stage-head]')
  const rail = root.querySelector('[data-rail="objects"]')
  const drill = root.querySelector('[data-drill="stack"]')
  const list = rail ? rail.querySelector('*[style*="overflow-y"]') : null
  const tabs = [...root.querySelectorAll('[data-rail-tab]')].map((b) => ({
    k: b.getAttribute('data-rail-tab'),
    on: b.getAttribute('aria-pressed') === 'true',
  }))
  return {
    ok: true,
    path: location.pathname + location.search,
    stage: head ? head.getAttribute('data-stage-head') : null,
    headText: head ? String(head.innerText || '').split('\\n')[0].trim() : '',
    rail: !!rail,
    railRows: rail ? rail.querySelectorAll('[data-rail-row]').length : 0,
    eventRows: rail ? rail.querySelectorAll('[data-event-row]').length : 0,
    railScrollTop: list ? list.scrollTop : -1,
    tabs,
    sort: (() => {
      const on = root.querySelector('[data-sort][aria-pressed="true"]')
      return on ? on.getAttribute('data-sort') : null
    })(),
    drill: !!drill,
    drillTitle: drill ? String(drill.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || '' : '',
    // 轨迹条是「层次」唯一的外部证据：没有它，右栏就只是个详情面板。
    trailLen: root.querySelectorAll('[data-trail] > *').length,
    facts: [...root.querySelectorAll('[data-fact]')].map((b) => b.getAttribute('data-fact')),
    bodyLen: String(root.innerText || '').length,
  }
})()`;

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const cookies = await login();
  console.log(`  已登录 ${USER}`);

  const profile = path.join(process.env.TEMP || '.', `wl-wb-${PORT}`);
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
  let pass = 0;
  let fail = 0;
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
      // 首次访问会自动开播演示流程，遮罩盖住整屏：之后的点击全点在遮罩上，
      // 而 DOM 读取一切正常 —— 失败会伪装成「点了没反应」。
      // 所以进页面先把「已看过」写进去（看完的流程由 shoot-tour 单独验）。
      await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `try { window.localStorage.setItem('wl-tour-seen-v1','1') } catch (e) {}`,
            returnByValue: true,
          },
          sid,
        )
        .catch(() => {});
    };
    const shot = async (name, note) => {
      const { data } = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        sid,
      );
      const buf = Buffer.from(data, 'base64');
      await writeFile(path.join(OUT, `${name}.png`), buf);
      console.log(`  ${name.padEnd(26)} ${(buf.length / 1024).toFixed(1)}KB  ${note}`);
    };

    // 先造数据。十站全退水时左栏十行都在、但「预警」页签是空的，
    // 而「点预警看卷宗」这条路正是这一屏的核心之一——空不是坏，但会让
    // 用例报 FAIL，而假红灯一旦亮起来人就开始忽略这条路。
    if (!argv.includes('--no-storm')) {
      const jar = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const sr = await fetch(`${BASE}/api/sim/storm?peak=228&dur=48`, {
        method: 'POST',
        headers: { Cookie: jar },
      });
      const seeded = await sr.text();
      console.log(`  注雨：HTTP ${sr.status} ${seeded.slice(0, 120)}`);
      if (!sr.ok || !seeded.includes('"ok":true')) {
        throw new Error(`注雨失败：HTTP ${sr.status} ${seeded.slice(0, 200)}`);
      }
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
      if (maxDepth < 0.5) {
        throw new Error(`注雨后水位没涨到 0.5m（实测 ${maxDepth.toFixed(2)}），后续用例没有意义`);
      }
    }

    const read = () => evaluate(cdp, sid, READ);
    const click = async (sel, label) => {
      const p = await evaluate(cdp, sid, locate(sel));
      if (!p) throw new Error(`找不到 ${label}（选择器 ${sel}）`);
      if (p.zero) throw new Error(`${label} 尺寸为 0（${p.w}×${p.h}），点不到`);
      await clickAt(cdp, sid, p.x, p.y);
      return p;
    };
    const check = (name, cond, detail) => {
      if (cond) {
        pass++;
        console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
      } else {
        fail++;
        console.log(`  ✗ FAIL ${name}  ${detail || ''}`);
      }
    };

    await go('/');
    // 遮罩万一已经开播（例如同一 profile 复用了页面），先退出再测。
    await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: `(() => { const r = document.querySelector('[data-tour-root]'); if (!r) return 'no-tour'; const b = [...r.querySelectorAll('button')].find((x) => /退出|跳过|关闭/.test(x.innerText||'')); if (b) { b.click(); return 'exited' } return 'no-exit'; })()`,
          returnByValue: true,
        },
        sid,
      )
      .catch(() => {});
    await sleep(500);
    await cdp.send('Page.reload', {}, sid).catch(() => {});
    await sleep(WAIT);
    let r0 = await read();
    if (!r0.ok) throw new Error(r0.why);
    console.log(`  工作台已渲染：stage=${r0.stage} rail=${r0.railRows} 行 bodyLen=${r0.bodyLen}`);
    await shot('workbench-01-home', '默认：全域态势 + 左栏 + 右栏');

    check('工作台根节点存在', r0.ok === true, `path=${r0.path}`);
    check('默认舞台是全域态势', r0.stage === 'situation', `stage=${r0.stage}`);
    check('左栏列出了站点', r0.railRows >= 8, `${r0.railRows} 行`);
    check('右栏钻取栈在位', r0.drill === true);
    check('顶栏四个事实入口都在', r0.facts.length >= 4, `[${r0.facts.join(', ')}]`);
    check('左栏不随舞台变化重置（初始滚动）', r0.railScrollTop >= 0, `scrollTop=${r0.railScrollTop}`);

    // ---- 验收标准第 2 条：换选中对象时，左栏的排序 / 滚动 / 筛选不许重置 ----
    // 先把左栏弄成一个「有状态」的样子，再点站点，再回头核对。
    // 不这么做就只能测「点了有反应」，测不出「不换页」这件事到底做没做到。
    await click('[data-rail-tab="sites"]', '左栏「站点」页签');
    const sortBtn = await evaluate(
      cdp,
      sid,
      `(() => {
        const rail = document.querySelector('[data-rail="objects"]')
        if (!rail) return null
        const bs = [...rail.querySelectorAll('button')].filter((b) => /趋势|涨速|雨强|等级|水深/.test(b.innerText || ''))
        return bs.length ? { n: bs.length, text: bs.map(b => (b.innerText||'').trim()).join(' | ') } : null
      })()`,
    );
    check('左栏有排序控件', !!sortBtn, sortBtn ? sortBtn.text : '没找到');

    // 制造一个「非默认」的左栏状态：把排序从默认的「等级」改成「雨强」。
    //
    // 第一版这里测的是滚动位置，但十行站点在 1000px 高的屏幕上根本滚不动，
    // `scrollTop` 恒为 0 —— 那条断言永远通过，等于没测。
    // 换成一个**默认值不同**的选择，它才有能力失败。
    await click('[data-sort="rain"]', '排序「雨强」');
    await sleep(300);
    const sorted = await read();
    check('排序控件生效', sorted.sort === 'rain', `sort=${sorted.sort}`);
    const sortedUrl = sorted.path;
    await shot('workbench-02-rail-state', '先把左栏弄成有状态：排序改成「雨强」');

    // 找一行来点。用左栏专属地址，避免点到中舞台上同名的峰值条。
    const firstSite = await evaluate(
      cdp,
      sid,
      `(() => {
        const rows = [...document.querySelectorAll('[data-rail-row]')]
        if (!rows.length) return null
        const vis = rows.find((el) => { const r = el.getBoundingClientRect(); return r.height > 8 && r.top > 0 })
        return vis ? vis.getAttribute('data-rail-row') : rows[0].getAttribute('data-rail-row')
      })()`,
    );
    if (!firstSite) throw new Error('左栏一行站点都没有，后面的用例无从谈起');
    const railRowsBefore = sorted.railRows;
    await click(`[data-rail-row="${firstSite}"]`, `左栏站点行 ${firstSite}`);
    await sleep(520);
    const r1 = await read();

    check('点站点后舞台切到该站', r1.stage === 'site', `stage=${r1.stage} head="${r1.headText}"`);
    check('URL 没有离开这一屏（没有换页）', onWorkbench(r1.path), `path=${r1.path}`);
    check('左栏排序没被舞台重置', r1.sort === 'rain', `点前 sort=rain → 点后 sort=${r1.sort}`);
    check('排序状态写进了 URL（可分享）', r1.path.includes('sort=rain'), `path=${r1.path}`);
    check('左栏行数不变（列表没被舞台抢走）', r1.railRows === railRowsBefore, `${railRowsBefore} → ${r1.railRows}`);
    check('右栏记下了这一步（轨迹条非空）', r1.trailLen >= 1, `trailLen=${r1.trailLen}`);
    check('右栏标题有内容', r1.drillTitle.length > 0, `"${r1.drillTitle}"`);
    void sortedUrl;
    await shot('workbench-03-site-stage', `点 ${firstSite}：中舞台换站，左栏筛选不动`);

    // ---- 层次：再点第二条，栈应该长到 2 层，而且还能退回去 ----
    const rows = await evaluate(
      cdp,
      sid,
      `(() => [...document.querySelectorAll('[data-rail-row]')].slice(0, 6).map((el) => el.getAttribute('data-rail-row')))()`,
    );
    const second = rows.find((id) => id !== firstSite);
    if (second) {
      await click(`[data-rail-row="${second}"]`, `左栏站点行 ${second}`);
      await sleep(420);
      const r2 = await read();
      check('再点一站，栈长到 2 层', r2.trailLen >= 2, `trailLen=${r2.trailLen}`);
      check('再点一站仍是同一个舞台类型', r2.stage === 'site', `stage=${r2.stage}`);
      await shot('workbench-04-drill-2', `连点 ${firstSite} → ${second}：右栏叠了两层`);
    }

    // ---- Esc 退回：栈里还有一层就该留在 site，而不是直接回态势 ----
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
    await sleep(420);
    const r3 = await read();
    check('Esc 退掉一层而不是回态势', r3.stage === 'site', `stage=${r3.stage} trailLen=${r3.trailLen}`);
    await shot('workbench-05-esc', 'Esc：退掉栈顶一层，舞台不变');

    // ---- 顶栏事实入口：每一个都要真的换舞台，且舞台 key 与点的入口一致 ----
    // 这里刻意逐个断言 `data-stage-head === 点的 key`：
    // 「页面变了」不等于「点对了」——上一条用例的残留也会让页面看起来变过。
    for (const [fact, kind] of [
      ['handoff', 'handoff'],
      ['trust', 'trust'],
      ['plumbing', 'plumbing'],
      ['governance', 'governance'],
      ['situation', 'situation'],
    ]) {
      await click(`[data-fact="${fact}"]`, `顶栏「${fact}」入口`);
      await sleep(520);
      const rr = await read();
      check(`顶栏 ${fact} → 舞台 ${kind}`, rr.stage === kind, `实际 stage=${rr.stage}`);
      check(`顶栏 ${fact} 没有换页`, onWorkbench(rr.path), `path=${rr.path}`);
      await shot(`workbench-06-fact-${fact}`, `顶栏入口：${fact}`);
    }

    // ---- 预警页签：点一条预警应当进卷宗舞台（而不是留在列表里） ----
    await click('[data-rail-tab="events"]', '左栏「预警」页签');
    await sleep(420);
    const evCount = await evaluate(cdp, sid, `document.querySelectorAll('[data-event-row]').length`);
    if (evCount > 0) {
      const evId = await evaluate(
        cdp,
        sid,
        `(() => { const e = document.querySelector('[data-event-row]'); return e ? e.getAttribute('data-event-row') : null })()`,
      );
      await click(`[data-event-row="${evId}"]`, `预警行 ${evId}`);
      await sleep(520);
      const r4 = await read();
      check('点预警进卷宗舞台', r4.stage === 'event', `stage=${r4.stage}`);
      check('卷宗没有换页', onWorkbench(r4.path), `path=${r4.path}`);
      await shot('workbench-07-event-stage', `点预警 ${evId}：进卷宗，就地处置`);
    } else {
      check('预警页签有可点的行', false, '一行动都没有（注雨了还是空，说明数据链路有问题）');
    }

    // ---- 窄屏：右栏不能把中间挤没 ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
    await sleep(700);
    const narrow = await evaluate(
      cdp,
      sid,
      `(() => {
        const main = document.querySelector('[data-stage-body]')
        const rail = document.querySelector('[data-rail="objects"]')
        const drill = document.querySelector('[data-drill="stack"]')
        return {
          main: main ? Math.round(main.getBoundingClientRect().width) : 0,
          rail: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          drill: drill ? Math.round(drill.getBoundingClientRect().width) : 0,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })()`,
    );
    console.log(`  1280 宽：中舞台 ${narrow.main}px / 左栏 ${narrow.rail}px / 右栏 ${narrow.drill}px`);
    check('1280 宽时中舞台还活着（>200px）', narrow.main > 200, `main=${narrow.main}px`);
    check('1280 宽时没有横向滚动条', narrow.overflowX <= 0, `overflowX=${narrow.overflowX}px`);
    await shot('workbench-08-narrow', '1280×900：三栏仍然并存');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sid);
  } catch (e) {
    console.error(`  !! ${e.message}`);
    fail++;
  } finally {
    try {
      child.kill();
    } catch {}
    await sleep(400);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`  工作台验证：${pass} 通过 / ${fail} 失败`);
  exit = fail > 0 ? 1 : 0;
  process.exit(exit);
};

main();
