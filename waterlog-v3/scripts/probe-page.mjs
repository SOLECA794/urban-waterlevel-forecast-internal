#!/usr/bin/env node
/**
 * 抓某个页面的控制台报错、网络失败与渲染出的可见文本。
 * 用途：截图出现空白页 / 怀疑某页没渲染出数据时，快速定位是哪个接口 500
 * 还是组件抛异常；加 --auth 后可以探"登录后才有内容"的页面。
 *
 *   node scripts/probe-page.mjs /model
 *   node scripts/probe-page.mjs /admin --auth
 *   node scripts/probe-page.mjs /model --wait 6000 --chars 1200
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const route = argv.find((a) => a.startsWith('/')) || '/';
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:8200');
const WAIT = Number(arg('wait', 5000));
const PORT = Number(arg('port', 9334));
const CHARS = Number(arg('chars', 400));
const AUTH = argv.includes('--auth');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'waterlog');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('未找到 Chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先拿会话 cookie。匿名探测 /admin 只会看到登录页，而登录页 401 的
// /api/auth/me 会被当成"接口坏了"——那是个假结论。
let cookies = [];
if (AUTH) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  cookies = (res.headers.getSetCookie?.() ?? []).map((line) => {
    const pair = line.split(';')[0];
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  });
}

const profile = path.join(process.env.TEMP || '.', `wlprobe-${PORT}`);
await rm(profile, { recursive: true, force: true });
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let version;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let seq = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.exception?.description || d.text}`);
  } else if (msg.method === 'Network.responseReceived') {
    const { url, status } = msg.params.response;
    if (url.includes('/api/')) logs.push(`[net ${status}] ${url.replace(BASE, '')}`);
  } else if (msg.method === 'Network.loadingFailed') {
    logs.push(`[net FAIL] ${msg.params.errorText}`);
  }
});
const send = (method, params = {}, sessionId) => {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 25000);
  });
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
for (const c of cookies) {
  await send('Network.setCookie', { name: c.name, value: c.value, url: BASE }, sessionId);
}
await send('Page.navigate', { url: `${BASE}${route}` }, sessionId);
await sleep(WAIT);

const { result } = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ title: document.title, text: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0, ${CHARS}), nodes: document.querySelectorAll('*').length })`,
  returnByValue: true,
}, sessionId);

console.log(`路由 ${route}${AUTH ? `（已登录 ${USER}）` : '（匿名）'}`);
console.log('页面状态：', result.value);
console.log('--- 控制台/网络 ---');
console.log(logs.length ? logs.join('\n') : '(无输出)');

try { child.kill(); } catch {}
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
