/**
 * 渲染文案里不该出现裸 markdown 星号。
 *
 * 为什么不用「扫源码」：源码里 `**` 出现在三种完全不同的地方——
 *   1. JSX 注释 `{/* ... *\/}` 里：永远不会显示，扫它就是噪音；
 *   2. 已经过 <Emph> 渲染的字符串（讲解稿、说明文）：星号会被转成加粗，正确；
 *   3. 直接塞进 JSX children 的字符串：这才是 bug，屏幕上会原样飘两个星号。
 * 前两类占了绝大多数，源码扫描只能靠「文件名白名单」去猜，猜错就是假红灯。
 * 红灯一假，人就开始忽略它——那比不检查更糟。
 *
 * 所以这里检查**用户真正看到的那层**：登录后逐页打开，
 * 读 document.body.innerText，找星号。同一个数字、同一处 bug，不会认错。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:8200');
const USER = 'admin';
const PASS = 'admin123';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

/**
 * 检查面 = 九个舞台 + 大屏。
 *
 * 工作台只有一屏，所以不能再按「路由」扫——要按**舞台**扫：
 * 每个舞台是另一条渲染路径，谁的文案里漏了星号都不会互相发现。
 * 入口一律靠可寻址属性（`data-fact` / `data-trust-link` / `data-rail-row`），
 * 不靠文字内容找按钮——文案会改，属性不会。
 */
const VIEWS = [
  { label: '全域态势', click: null },
  { label: '值班交接', click: '[data-fact="handoff"]' },
  { label: '模型可信度', click: '[data-fact="trust"]' },
  { label: '链路与接口', click: '[data-fact="plumbing"]' },
  { label: '治理', click: '[data-fact="governance"]' },
  { label: '规则预演', click: '[data-trust-link="rules"]', via: '[data-fact="trust"]' },
  { label: '站点舞台', click: '[data-rail-row]' },
  { label: '预警卷宗', click: '[data-rail-tab="events"]', then: '[data-event-row]' },
  { label: '大屏', click: '[data-fact="wall"]' },
];

function httpJson(url, opts = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...opts }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome');
  const login = await httpJson(
    new URL('/api/auth/login', BASE),
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ username: USER, password: PASS }),
  );
  if (login.status !== 200) throw new Error('登录失败：' + login.status + ' ' + login.body);
  const raw = [].concat(login.headers['set-cookie'] || []).join('; ');
  const cookie = raw
    .split('; ')
    .filter((p) => p.startsWith('wl_session='))
    .map((p) => {
      const [k, ...v] = p.split('=');
      return { name: k, value: v.join('='), domain: new URL(BASE).hostname, path: '/' };
    });
  if (!cookie.length) throw new Error('登录没拿到 wl_session cookie');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-stars-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1600,1000',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const wsFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(wsFile); i++) await sleep(100);
  const [, wsPath] = fs.readFileSync(wsFile, 'utf8').split('\n');
  const httpUrl = `http://127.0.0.1:${fs.readFileSync(wsFile, 'utf8').split('\n')[0]}`;
  const targets = JSON.parse((await httpJson(httpUrl + '/json/list')).body);
  const page = targets.find((t) => t.type === 'page');
  const ws = await connect(page.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pend.has(msg.id)) {
      const { res, rej } = pend.get(msg.id);
      pend.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const cmd = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pend.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const ev = async (expr) => {
    const r = await cmd('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const t = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error('页面求值异常：' + t);
    }
    return r.result?.value;
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Network.enable');
  for (const c of cookie) await cmd('Network.setCookie', { ...c, url: BASE });

  let hit = 0;
  const rows = [];
  const probe = async (where) => {
    const text = await ev(`(document.body.innerText || '').replace(/\s+/g, ' ')`);
    const idx = text.indexOf('**');
    if (idx >= 0) {
      hit += 1;
      rows.push({ where, ctx: text.slice(Math.max(0, idx - 46), idx + 46) });
    }
  };

  // 每次从首页重新开始：舞台之间会互相改变左栏状态，
  // 顺着点下去第三个之后就不再是原来的那个右栏内容了。
  for (const v of VIEWS) {
    await cmd('Page.navigate', { url: new URL('/', BASE).href });
    await sleep(2400);
    // 有些入口在别的舞台里（「规则预演」要先到「模型可信度」才看得见）。
    // 先走 `via`，否则会报「入口找不到」——那不是入口坏了，是没走到那一层。
    if (v.via) {
      await ev(`(() => { const el = document.querySelector(${JSON.stringify(v.via)}); if (el) el.click(); return !!el })()`);
      await sleep(1400);
    }
    const clicked = await ev(`(() => {
      const sel = ${JSON.stringify(v.click)};
      if (!sel) return 'none';
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      el.click();
      return 'ok';
    })()`);
    if (v.click && clicked !== 'ok') {
      hit += 1;
      rows.push({ where: v.label, ctx: `入口 ${v.click} 找不到（${clicked}）` });
      continue;
    }
    await sleep(1300);
    if (v.then) {
      await ev(`(() => { const el = document.querySelector(${JSON.stringify(v.then)}); if (el) el.click(); return !!el })()`);
      await sleep(900);
    }
    await probe(v.label);
  }

  // 大屏是另一条路由（投屏用），单独走一遍
  await cmd('Page.navigate', { url: new URL('/board', BASE).href });
  await sleep(4200);
  await probe('大屏页');

  for (const r of rows) {
    console.log(`  FAIL  ${r.where.padEnd(12)}  附近：…${r.ctx}…`);
  }
  console.log(
    `
  ${hit === 0 ? '全部 ' + (VIEWS.length + 1) + ' 个检查面里没有裸星号' : hit + ' 处出现了星号'}`,
  );
  if (hit === 0) console.log('  —— OK 渲染文案里没有裸 markdown 星号');

  ws.close();
  chrome.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(hit === 0 ? 0 : 1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败：' + e.message));
  });
}

main().catch((e) => {
  console.error('  失败：' + e.message);
  process.exit(1);
});
