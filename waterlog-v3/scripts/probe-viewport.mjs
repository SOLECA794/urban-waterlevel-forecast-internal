// 探测真实视口：用 CDP 打开 /board，读 window.innerWidth/Height 与 devicePixelRatio。
import { spawn } from 'node:child_process'
import http from 'node:http'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.BASE || 'http://127.0.0.1:8200'
const SIZE = process.argv.find((a) => a.startsWith('--size='))?.slice(7) || '1600,900'
const PORT = 9334

const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', `--window-size=${SIZE}`, 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (path) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${path}`, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d))) }).on('error', rej)
})

await sleep(2200)
const targets = await getJson('/json/list')
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

await send('Page.enable')
await send('Runtime.enable')
const { result: sid } = await send('Target.attachToTarget', { targetId: page.id, flatten: true })
await send('Page.navigate', { url: `${BASE}/board?theme=light&scene=0`, sessionId: sid.sessionId })
await sleep(5200)
const res = await send('Runtime.evaluate', {
  expression: `JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,ratio:+(innerWidth/innerHeight).toFixed(3),docW:document.documentElement.clientWidth})`,
  returnByValue: true,
}, sid.sessionId)
console.log('viewport', res.result?.result?.value ?? JSON.stringify(res).slice(0,300))
ws.close(); proc.kill()
