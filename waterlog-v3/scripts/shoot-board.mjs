// 大屏截图：1920×1080 真屏尺寸，深/浅两主题各一张。
// 不复用 shoot.mjs，是因为大屏要按 1920×1080 抓、只抓两页、且要等轮换动画落定。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const BASE = arg('base', 'http://127.0.0.1:8200').replace(/\/$/, '')
const OUT = arg('out', 'shots')
const USER = arg('user', 'admin')
const PASS = arg('pass', 'admin123')
const WAIT = Number(arg('wait', '3200'))
const PORT = Number(arg('port', '9333'))

// --themes dark,light --scenes 0,1,2,3 的笛卡尔积；不传则深/浅各抓第 0 屏
const THEMES = arg('themes', 'dark,light').split(',').map((x) => x.trim()).filter(Boolean)
const SCENES = arg('scenes', '0').split(',').map((x) => x.trim()).filter(Boolean)
const JOBS = []
for (const t of THEMES) {
  for (const sc of SCENES) {
    JOBS.push({
      name: `board-${t}${SCENES.length > 1 ? `-s${sc}` : ''}`,
      url: `/board?theme=${t}&scene=${sc}`,
    })
  }
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

async function getJson(url, tries = 40) {
  let last
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
      last = new Error(`${url} -> ${res.status}`)
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`连不上 ${url}：${last && last.message}`)
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  if (!res.ok) throw new Error(`登录失败 ${res.status}`)
  const jar = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const pairs = jar.map((c) => c.split(';')[0])
  if (pairs.length === 0) throw new Error('登录成功但没拿到 cookie')
  return pairs
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.waiters = []
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        this.waiters = this.waiters.filter((w) => {
          if (w.method !== msg.method) return true
          w.resolve(msg.params)
          return false
        })
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  once(method, ms = 20000) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve }
      this.waiters.push(w)
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w)
        reject(new Error(`timeout ${method}`))
      }, ms)
    })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const pairs = await login()
  const cookieName = pairs[0].split('=')[0]
  const cookieValue = pairs[0].slice(cookieName.length + 1)
  console.log(`  已登录 ${USER}，cookie ${cookieName}`)

  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
  if (!chrome) throw new Error('未找到 Chrome/Edge，无法截图')

  const profile = path.join(process.env.TEMP || '.', `wlboard-cdp-${PORT}`)
  fs.rmSync(profile, { recursive: true, force: true })

  const child = spawn(
    chrome,
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
  )

  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`)
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
    })
    const cdp = new CDP(ws)

    for (const job of JOBS) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Network.enable', {}, sessionId)
      await cdp.send(
        'Network.setCookie',
        { name: cookieName, value: cookieValue, url: BASE, path: '/' },
        sessionId,
      )
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
        sessionId,
      )
      const loaded = cdp.once('Page.loadEventFired')
      await cdp.send('Page.navigate', { url: BASE + job.url }, sessionId)
      await loaded.catch(() => {})
      await sleep(WAIT)
      const shot = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        sessionId,
      )
      const file = path.join(OUT, `${job.name}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      const kb = (fs.statSync(file).size / 1024).toFixed(1)
      console.log(`  ${job.name.padEnd(12)} ok ${kb.padStart(7)}KB  ${job.url}`)
      await cdp.send('Target.closeTarget', { targetId })
    }
    ws.close()
  } finally {
    child.kill()
  }
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
