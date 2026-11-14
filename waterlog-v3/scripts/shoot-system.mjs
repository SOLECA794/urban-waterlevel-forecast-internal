#!/usr/bin/env node
/**
 * 系统页的两个抽屉走查：链路层（挂了会怎样）与接口行（返回什么）。
 *
 * 为什么要单独一个脚本：这两个抽屉的数据源是**页面里的常量数组**，
 * 不是接口。常量写错一个字段名，tsc 不会报（它是 string），
 * 页面照渲染，只是抽屉内容是空的或者对不上号。
 * 所以必须真点一遍，读回文字确认不是空的。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8200';
const PORT = 9355;
const OUT = path.join(ROOT, 'shots');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => p && existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const cookies = (res.headers.getSetCookie?.() ?? []).map((line) => {
  const [pair] = line.split(';');
  const i = pair.indexOf('=');
  return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
});

await mkdir(OUT, { recursive: true });
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
  '--proxy-bypass-list=<-loopback>', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'wl-sys')}`,
  '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

let ver;
for (let i = 0; i < 60; i++) {
  try { const x = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (x.ok) { ver = await x.json(); break; } } catch {}
  await sleep(200);
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
const send = (method, params = {}, sessionId) => new Promise((r, j) => {
  const id = ++seq; pend.set(id, { res: r, rej: j }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
for (const c of cookies) await send('Network.setCookie', { name: c.name, value: c.value, url: BASE }, sid);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);

const ev = async (expr) => {
  const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (x.exceptionDetails) throw new Error('页面求值异常：' + x.exceptionDetails.text + ' ' + (x.exceptionDetails.exception?.description || ''));
  return x.result?.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sid);
  await writeFile(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};
const click = async (sel) => {
  const box = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) };
  })()`);
  if (!box) throw new Error('找不到元素：' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' }, sid);
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
  await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
  await sleep(700);
};
const READ = `(() => {
  const d = document.querySelector('[data-drawer="site"]');
  if (!d) return { open: false };
  const t = String(d.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  return { open: true, width: Math.round(d.getBoundingClientRect().width), title: t[0] || '', sub: t[1] || '', sections: [...d.querySelectorAll('[data-sec]')].map((e) => e.getAttribute('data-sec')), body: t.join(' / ').slice(0, 260) };
})()`;

await send('Page.navigate', { url: `${BASE}/system` }, sid);
await sleep(4200);
// 先把「已看过演示」写上，否则一进页面就弹一层遮罩把链路挡住。
// 必须在导航到真实页面之后写：about:blank 上读 localStorage 会抛 SecurityError。
await ev(`(() => { try { window.localStorage.setItem('wl-tour-seen-v1','1') } catch {} })()`);
await send('Page.reload', {}, sid);
await sleep(4200);

console.log('  系统页交互走查');
let bad = 0;

// 四层链路各点一次
for (const k of ['数据源', 'Python 引擎', 'Go API', '浏览器']) {
  await click(`[data-layer="${k}"]`);
  const d = await ev(READ);
  // 标题必须含本次点的 key：抽屉盖住右栏时会点到抽屉自己，
  // 内容还是上一条的，光看「节数够不够」会当成通过。
  const ok = d.open && d.sections.length >= 3 && (d.body || '').length > 80 && (d.title || '').includes(k);
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} 链路「${k}」 —— ${d.open ? `宽 ${d.width} · 标题 ${d.title} · 节 ${d.sections.join('/')}` : '抽屉没开'}`);
  if (ok) console.log(`        ${d.body.slice(0, 150)}…`);
  await ev(`document.querySelector('[data-drawer="site"] button[aria-label="关闭详情"]')?.click()`);
  await sleep(500);
}

// 接口行点两条：一条 GET、一条写接口
for (const k of ['GET /api/overview', 'POST /api/alerts/{id}/ack']) {
  await click(`[data-api="${k}"]`);
  const d = await ev(READ);
  const ok = d.open && d.sections.length >= 4 && (d.body || '').length > 80 && (d.title || '') === k;
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} 接口「${k}」 —— ${d.open ? `宽 ${d.width} · 标题 ${d.title} · 节 ${d.sections.join('/')}` : '抽屉没开'}`);
  if (ok) console.log(`        ${d.body.slice(0, 180)}…`);
  await ev(`document.querySelector('[data-drawer="site"] button[aria-label="关闭详情"]')?.click()`);
  await sleep(500);
}

// 截图一张留证
await click(`[data-layer="Python 引擎"]`);
await shot('system-layer-drawer');
console.log('\n  截图 shots/system-layer-drawer.png');
console.log(`\n  ${bad === 0 ? '六项全部通过' : bad + ' 项有问题'}`);
child.kill();
process.exit(bad ? 1 : 0);
