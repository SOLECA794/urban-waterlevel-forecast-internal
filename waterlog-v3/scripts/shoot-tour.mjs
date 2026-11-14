#!/usr/bin/env node
/**
 * 演示流程走查：把九步全点一遍，每步截图并读回卡片文字。
 *
 * 为什么不是「看一眼首页有没有浮层」：流程的价值全在**跨页那几步**——
 * 第 3 步要跳到 /live、第 5 步要跳到 /alerts……任一步的目标锚点在 DOM 里
 * 找不到（改名了、被条件渲染藏了），那一步就会退化成一张居中的空卡片，
 * 而首页上看着一切正常。所以必须**逐步**验证锚点命中率。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8200';
const PORT = 9351;
const OUT = path.join(ROOT, 'shots');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
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
  `--user-data-dir=${path.join(process.env.TEMP, 'wl-tour')}`, 'about:blank'], { stdio: 'ignore' });

let ver;
for (let i = 0; i < 60; i++) {
  try { const x = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (x.ok) { ver = await x.json(); break; } } catch {}
  await sleep(200);
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map(); const ls = new Set();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method) for (const f of ls) f(m);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
for (const c of cookies) await send('Network.setCookie', { name: c.name, value: c.value, url: BASE }, sid);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);

const ev = async (expr) => {
  const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (x.exceptionDetails) throw new Error(x.exceptionDetails.text + ' ' + (x.exceptionDetails.exception?.description || ''));
  return x.result?.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sid);
  await writeFile(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};

// 清掉「已看过」，让流程自动开播
await send('Page.navigate', { url: `${BASE}/` }, sid);
await sleep(2000);
await ev(`window.localStorage.removeItem('wl-tour-seen-v1')`);
await send('Page.navigate', { url: `${BASE}/` }, sid);
await sleep(5200);

const READ = `(() => {
  const root = document.querySelector('[data-tour-root]');
  if (!root) return { open: false };
  const txt = String(root.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
  const spot = root.querySelector('div[style*="9999px"]');
  return {
    open: true,
    step: txt[0] || '',
    title: txt[1] || '',
    hasSpot: !!spot,
    path: window.location.pathname,
    bodyLen: (txt[2] || '').length,
  };
})()`;

console.log('  演示流程逐步走查');
const report = [];
for (let i = 0; i < 9; i++) {
  await sleep(1500);
  const d = await ev(READ);
  await shot(`tour-${String(i + 1).padStart(2, '0')}`);
  if (!d.open) { report.push(`第 ${i + 1} 步 —— FAIL 卡片不见了（流程提前中断）`); break; }
  const ok = d.hasSpot;
  report.push(`第 ${i + 1} 步 ${d.step.padEnd(9)} ${d.path.padEnd(9)} ${ok ? '锚点命中' : 'FAIL 锚点未命中（卡片居中）'} · ${d.title}`);
  if (i === 8) break;
  await ev(`(() => {
    const btns = [...document.querySelectorAll('[data-tour-root] button')];
    const next = btns.find((b) => (b.innerText || '').includes('下一步'));
    if (next) next.click();
  })()`);
}

console.log('');
for (const l of report) console.log('  ' + l);
const bad = report.filter((r) => /FAIL/.test(r));
console.log(`\n  ${bad.length === 0 ? '全部九步锚点命中' : bad.length + ' 步有问题'}`);
child.kill();
process.exit(bad.length ? 1 : 0);
