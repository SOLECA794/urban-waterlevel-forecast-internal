// 九页展厅大屏截图 + 校验：每页定屏（?page=N）抓一张 1920×1080，
// 并读回「这一页到底画出了什么」，因为截图只能证明"有像素"，证明不了"这是第 N 页的图"。
//
// 为什么单独一个脚本而不复用 shoot-board.mjs：
//   - 那个脚本按主题×场景抓，是给旧三屏大屏（/board/legacy）用的；
//   - 这个要跑九页、要断言每页的页签 key 与图表数量，还要防「图没画出来但页面没白」。
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
const WAIT = Number(arg('wait', '2600'))
const PORT = Number(arg('port', '9337'))

// 九页的 key 必须与 web/src/board/NineBoard.tsx 的 NINE_PAGES 一致。
// 写死一份是有意的：脚本若跟着源码自动取，源码把某一页改名后脚本会静默跟着改，
// 「这一页叫什么」就再也没有第二个人能核对。
// `draw` 是这一页用什么画出来的：'svg' 折线/散点、'div' 横条与滑块、'tiles' 地图瓦片。
// 之前所有页都断言「有 svg」，结果横条与滑块页（zcross/zrank/zrain）报假红灯 ——
// **断言要跟着实现方式走，不能假设全站都用同一种画法。**
const PAGES = [
  { n: 1, key: 'overview', cards: 8, draw: 'svg' },
  { n: 2, key: 'zmap', cards: 0, draw: 'tiles' },
  { n: 3, key: 'zlines', cards: 0, draw: 'svg' },
  { n: 4, key: 'zline1', cards: 0, draw: 'svg' },
  { n: 5, key: 'zpoints', cards: 0, draw: 'svg' },
  { n: 6, key: 'zcross', cards: 0, draw: 'div' },
  { n: 7, key: 'zacc', cards: 0, draw: 'svg' },
  { n: 8, key: 'zrank', cards: 0, draw: 'div' },
  { n: 9, key: 'zrain', cards: 0, draw: 'div' },
]

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

/**
 * 一次读全这一页的可观测事实。
 * 一次读全而不是分几次读：两次读之间 SSE 会推新数据、图表会重排，
 * 「什么变了什么没变」就没法归因了。
 */
const READ = `(() => {
  const root = document.querySelector('[data-board="nine"]');
  if (!root) return { ok: false, why: '没有 data-board="nine"（不是九页大屏，或整页没渲染）' };
  const cards = [...root.querySelectorAll('[data-zoom-card]')];
  const kpi = root.querySelector('[data-kpi]');
  const svgs = [...root.querySelectorAll('svg')];
  const text = (root.innerText || '').replace(/\\s+/g, ' ').trim();
  return {
    ok: true,
    page: root.getAttribute('data-page'),
    key: root.getAttribute('data-page-key'),
    cards: cards.length,
    svg: svgs.length,
    canvas: root.querySelectorAll('canvas').length,
    tiles: root.querySelectorAll('img[src*="autonavi"]').length,
    kpiText: kpi ? (kpi.innerText || '').replace(/\\s+/g, ' ').trim() : '',
    cardTitles: cards.map((c) => (c.querySelector('span') ? c.querySelector('span').textContent.trim() : '')),
    headText: text.slice(0, 160),
    textLen: text.length,
  };
})()`

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const pairs = await login()
  const cookieName = pairs[0].split('=')[0]
  const cookieValue = pairs[0].slice(cookieName.length + 1)
  console.log(`  已登录 ${USER}，cookie ${cookieName}`)

  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
  if (!chrome) throw new Error('未找到 Chrome/Edge，无法截图')

  const profile = path.join(process.env.TEMP || '.', `wlboard9-cdp-${PORT}`)
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

  let pass = 0
  let fail = 0
  const check = (ok, label, detail) => {
    if (ok) {
      pass += 1
      console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
    } else {
      fail += 1
      console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
    }
  }

  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`)
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
    })
    const cdp = new CDP(ws)

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Network.setCookie', { name: cookieName, value: cookieValue, url: BASE, path: '/' }, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId)

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description
        throw new Error('页面求值异常：' + (r.exceptionDetails.text || '') + ' ' + (d || ''))
      }
      return r.result ? r.result.value : undefined
    }

    for (const page of PAGES) {
      const url = `${BASE}/board?page=${page.n - 1}`
      const loaded = cdp.once('Page.loadEventFired')
      await cdp.send('Page.navigate', { url }, sessionId)
      await loaded.catch(() => {})
      // 等两件事：轮播被 ?page= 定住（不会自己翻走）+ 图表首帧画完。
      // 只等 load 就抓会拍到空画布 —— 这是本项目踩过四次的坑。
      await sleep(WAIT)

      const r = await evaluate(READ)
      if (!r || !r.ok) {
        check(false, `第 ${page.n} 页 ${page.key} 渲染`, (r && r.why) || '读不到')
        continue
      }

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId)
      const file = path.join(OUT, `board9-${String(page.n).padStart(2, '0')}-${page.key}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      const kb = (fs.statSync(file).size / 1024).toFixed(1)

      check(r.key === page.key, `第 ${page.n} 页是「${page.key}」`, `key=${r.key} · ${kb}KB`)
      check(r.page === String(page.n - 1), `第 ${page.n} 页停在 ?page=${page.n - 1}`, `data-page=${r.page}`)
      check(r.cards === page.cards, `第 ${page.n} 页图表块数 = ${page.cards}`, `实际 ${r.cards}`)
      if (page.draw === 'tiles') {
        check(r.tiles >= 4, `第 ${page.n} 页地图瓦片已铺开`, `tiles=${r.tiles}`)
      } else if (page.draw === 'svg') {
        check(r.svg >= 1, `第 ${page.n} 页有 SVG 图形`, `svg=${r.svg}`)
      } else {
        // 横条 / 滑块 / 柱阵都是 div 画的，只断言「这一页真有内容」，
        // 再看截图字节数排除「一片纯色底」。
        check(r.textLen > 120, `第 ${page.n} 页有内容`, `文本 ${r.textLen} 字`)
      }
      // 「没有裸 markdown 星号」在大屏上也一样要查：讲解文案里写 **加粗** 会原样飘出来
      check(!r.headText.includes('**'), `第 ${page.n} 页没有裸星号`)
      if (page.n === 1) {
        check(r.kpiText.length > 12, `第 1 页 KPI 条有数字`, r.kpiText.slice(0, 90))
        check(r.cardTitles.length === 8 && r.cardTitles.every((t) => t && t.length >= 2), `第 1 页八块图都有标题`, r.cardTitles.join(' / '))
      }
      console.log(`     ${page.n}. ${page.key.padEnd(9)} head="${r.headText.slice(0, 70)}"`)
    }

    ws.close()
  } finally {
    child.kill()
  }

  console.log('')
  console.log(`  九页大屏：✓ ${pass}  ✗ ${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
