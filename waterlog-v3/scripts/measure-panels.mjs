import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:8200')
const USER = arg('user', 'admin')
const PASS = arg('pass', 'admin123')
const PORT = Number(arg('port', '9334'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(path) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
      return await r.json()
    } catch {
      await sleep(250)
    }
  }
  throw new Error('CDP 未就绪')
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))
if (!CHROME) throw new Error('找不到 Chrome')

const proc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    `--user-data-dir=${process.env.TEMP}\\wl-measure-${PORT}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

try {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  const cookies = login.headers.getSetCookie().map((c) => {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1) }
  })

  const targets = await getJson('/json/list')
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const myId = ++id
      pending.set(myId, resolve)
      ws.send(JSON.stringify({ id: myId, method, params, sessionId }))
    })

  const { result: t } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
  const sid = a.sessionId
  await send('Page.enable', {}, sid)
  await send('Network.enable', {}, sid)
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sid)
  for (const c of cookies) {
    await send('Network.setCookie', { ...c, domain: '127.0.0.1', path: '/' }, sid)
  }
  await send('Page.navigate', { url: `${BASE}/board?theme=light&scene=0` }, sid)
  await sleep(6000)

  const { result: ev } = await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const out = [];
        document.querySelectorAll('main section').forEach((s) => {
          const body = s.lastElementChild;
          out.push({
            title: (s.textContent || '').slice(0, 10),
            h: Math.round(s.getBoundingClientRect().height),
            sh: s.scrollHeight,
            bh: body ? Math.round(body.getBoundingClientRect().height) : -1,
            bsh: body ? body.scrollHeight : -1,
            kids: body ? Array.from(body.children).map((k) => Math.round(k.getBoundingClientRect().height)) : [],
          });
        });
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    },
    sid,
  )
  const rows = JSON.parse(ev.result.value)
  for (const r of rows) {
    const flag = r.bsh > r.bh + 1 ? '  <<< OVERFLOW' : ''
    console.log(`${r.title.padEnd(10)} h=${r.h} body=${r.bh}/${r.bsh} kids=[${r.kids.join(',')}]${flag}`)
  }
  ws.close()
} finally {
  proc.kill()
}
