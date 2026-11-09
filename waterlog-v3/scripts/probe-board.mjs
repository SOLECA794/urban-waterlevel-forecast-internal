// 只读探针：确认大屏上的站点标记到底渲染了几个、坐标在哪。
// 用于排查「地图上只看到一个点」——眼睛看不出来是没渲染还是被推出画布。
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))
const PORT = 9347
const BASE = process.argv[2] ?? 'http://127.0.0.1:8200'
const USER = 'admin'
const PASS = 'admin123'
const profile = join(tmpdir(), `wlprobe-${PORT}`)
rmSync(profile, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-proxy-server',
  '--proxy-bypass-list=<-loopback>',
  '--disable-gpu',
  '--window-size=1920,1080',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getJson(path, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
      if (r.ok) return await r.json()
    } catch {
      /* chrome 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('CDP 未就绪: ' + path)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiting = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (m.error) reject(new Error(JSON.stringify(m.error)))
        else resolve(m.result)
      } else if (m.method) {
        this.events.push(m)
      }
    })
  }
  send(method, params = {}) {
    const id = (this.id += 1)
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result.value
  }
}

const main = async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const ver = await getJson('/json/version')
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const browser = new Cdp(ws)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })

  const page = new Cdp(ws)
  const send = (method, params = {}) => {
    const id = (page.id += 1)
    ws.send(JSON.stringify({ id, sessionId, method, params }))
    return new Promise((resolve, reject) => page.waiting.set(id, { resolve, reject }))
  }
  const peval = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  await send('Network.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${BASE}/board` })
  await sleep(1500)
  for (const c of cookie.split('; ')) {
    const [name, value] = c.split('=')
    await send('Network.setCookie', { name, value, domain: '127.0.0.1', path: '/' })
  }
  await send('Page.navigate', { url: `${BASE}/board?edit=1` })
  await sleep(6500)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('shots', { recursive: true })
  writeFileSync('shots/board-edit.png', Buffer.from(shot.data, 'base64'))
  console.log('布局模式截图 -> shots/board-edit.png')

  const out = await peval(`(() => {
    const svgs = [...document.querySelectorAll('svg')]
    const marks = [...document.querySelectorAll('svg g')].filter(g => (g.getAttribute('style')||'').includes('translate'))
    return {
      svgCount: svgs.length,
      markCount: marks.length,
      marks: marks.slice(0, 12).map(g => {
        const st = g.getAttribute('style') || ''
        const bb = g.getBoundingClientRect()
        const txt = [...g.querySelectorAll('text')].map(t => t.textContent).join('|')
        return { st: st.slice(0, 60), x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), txt }
      }),
      tiles: document.querySelectorAll('img[src*="autonavi"]').length,
    }
  })()`)
  console.log(JSON.stringify(out, null, 2))

  chrome.kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('失败：', e.message)
  chrome.kill()
  process.exit(1)
})
