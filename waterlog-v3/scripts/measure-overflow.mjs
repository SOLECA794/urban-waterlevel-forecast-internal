// 检查 /board 每个面板内部是否溢出（scrollHeight > clientHeight），并输出首行标题，
// 这样不用靠看缩略图猜「内容有没有被切掉」。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const PORT = 9345
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k)
  return i > 0 ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8200')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getJson(path) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(250)
  }
  throw new Error('chrome devtools 连不上')
}
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiters = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.waiters.has(m.id)) {
        const w = this.waiters.get(m.id)
        this.waiters.delete(m.id)
        m.error ? w.rej(new Error(m.error.message)) : w.res(m.result)
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

const bin = CHROME.find((p) => existsSync(p)) ?? CHROME[0]
const chrome = spawn(bin, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-proxy-server',
  '--proxy-bypass-list=<-loopback>',
  `--user-data-dir=${process.env.TEMP}\\wlprobe-${PORT}`,
], { stdio: 'ignore' })

const ver = await getJson('/json/version')
const ws = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const cdp = new CDP(ws)

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})
const cookie = (login.headers.getSetCookie() ?? []).map((c) => {
  const [pair] = c.split(';')
  return { name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1) }
})

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Network.enable', {}, sessionId)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId)
for (const c of cookie) await cdp.send('Network.setCookie', { ...c, domain: '127.0.0.1', path: '/' }, sessionId)
await cdp.send('Page.navigate', { url: `${BASE}/board?theme=light&scene=0` }, sessionId)
await sleep(5200)

const expr = `(() => {
  const out = []
  document.querySelectorAll('main section').forEach((el) => {
    const title = el.getAttribute('data-t') || (el.textContent || '').trim().slice(0, 10)
    const body = el.lastElementChild
    const r = el.getBoundingClientRect()
    out.push({
      title,
      top: Math.round(r.top),
      h: Math.round(r.height),
      bodyClient: body ? body.clientHeight : -1,
      bodyScroll: body ? body.scrollHeight : -1,
      over: body ? Math.max(0, body.scrollHeight - body.clientHeight) : -1,
    })
  })
  return JSON.stringify(out)
})()`
const { result } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)
const rows = JSON.parse(result.value)
for (const r of rows) {
  const flag = r.over > 4 ? `  <== 溢出 ${r.over}px` : ''
  console.log(`${String(r.top).padStart(4)} h${String(r.h).padStart(4)} body ${r.bodyClient}/${r.bodyScroll} | ${r.title}${flag}`)
}

await cdp.send('Target.closeTarget', { targetId })
ws.close()
chrome.kill()
