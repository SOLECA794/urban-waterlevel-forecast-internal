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

const PAGES = [
  ['/', '一张图'],
  ['/live', '实时地图'],
  ['/sites', '站点列表'],
  ['/sites/S08', '站点详情'],
  ['/alerts', '预警中心'],
  ['/shift', '值班台'],
  ['/model', '模型评估'],
  ['/rules', '规则配置'],
  ['/system', '系统状态'],
  ['/admin', '管理台'],
  ['/board', '大屏'],
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
  for (const [route, label] of PAGES) {
    await cmd('Page.navigate', { url: new URL(route, BASE).href });
    await sleep(route === '/board' ? 4200 : 2200);
    // 抽屉是额外的渲染面：站名/行的可点元素点开后，抽屉里的文案也要检查
    const text = await ev(`(() => {
      const strip = (s) => s.replace(/\\s+/g, ' ');
      return strip(document.body.innerText || '');
    })()`);
    const idx = text.indexOf('**');
    if (idx >= 0) {
      hit++;
      rows.push({ route, label, where: text.slice(Math.max(0, idx - 46), idx + 46) });
    }
  }
  // 打开一次抽屉再查：抽屉文案走的是另一条渲染路径
  await cmd('Page.navigate', { url: new URL('/sites', BASE).href });
  await sleep(2200);
  const opened = await ev(`(() => {
    const el = document.querySelector('[data-site-row]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (opened) {
    await sleep(1400);
    const dt = await ev(`(document.body.innerText || '').replace(/\\s+/g, ' ')`);
    const di = dt.indexOf('**');
    if (di >= 0) {
      hit++;
      rows.push({ route: '/sites(抽屉)', label: '抽屉', where: dt.slice(Math.max(0, di - 46), di + 46) });
    }
  }

  for (const r of rows) {
    console.log(`  FAIL  ${r.route.padEnd(14)} ${r.label}  附近：…${r.where}…`);
  }
  console.log(
    `\n  ${hit === 0 ? '全部 ' + PAGES.length + ' 页渲染文案里没有裸星号' : hit + ' 处页面上出现了星号'}`,
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
