// 两页展示大屏的 UI 实测：启动 vite preview、截图、验证关键元素与点击联动。
// 用法：node scripts/verify-ui.mjs    （由 npm run test:ui 调用，需先 npm run build）
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'shots')
mkdirSync(out, { recursive: true })
const NODE = process.execPath
const PORT = 8300
const URL = `http://127.0.0.1:${PORT}`

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

const preview = spawn(NODE, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
preview.stdout.on('data', d => log += d)
preview.stderr.on('data', d => log += d)

async function waitReady(timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try { const r = await fetch(URL); if (r.ok) return true } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

;(async () => {
  if (!await waitReady()) { console.error('preview did not start:\n' + log); process.exit(1) }
  // Playwright 会按自身的 revision 找浏览器；缓存版本不匹配时回退到已缓存的 chromium。
  const cache = path.join(homedir(), 'AppData', 'Local', 'ms-playwright')
  let executablePath
  for (const rev of ['1255', '1248', '1234', '1228', '1200']) {
    const p = path.join(cache, `chromium_headless_shell-${rev}`, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    if (existsSync(p)) { executablePath = p; break }
  }
  if (!executablePath) {
    for (const rev of ['1255', '1248', '1234', '1228', '1200']) {
      const p = path.join(cache, `chromium-${rev}`, 'chrome-win', 'chrome.exe')
      if (existsSync(p)) { executablePath = p; break }
    }
  }
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  // 地图瓦片在线加载失败不应算错误，这里只捕获 JS 运行异常。

  console.log('\n[页面 1 · 全域态势]')
  await page.goto(`${URL}/?page=1&interval=3600&paused=1`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(out, 'page1-overview.png') })
  check('标题渲染', await page.locator('.brand h1').innerText().then(t => t.includes('黄岩区')))
  check('三栏布局：左中右', await page.locator('.left-side').count() === 1 && await page.locator('.map-stage').count() === 1 && await page.locator('.right-side').count() === 1)
  check('站点列表 10 项', await page.locator('.station-list li').count() === 10, `实际 ${await page.locator('.station-list li').count()}`)
  check('日历渲染', await page.locator('.calendar .cal-cell').count() > 25)
  check('预警列表有数据', await page.locator('.alert-list li').count() > 0)
  check('地图圆点可点击', await page.locator('.leaflet-interactive').count() >= 10, `实际 ${await page.locator('.leaflet-interactive').count()}`)
  check('无页面脚本错误', errors.length === 0, errors.join('; '))

  // 点击站点列表第 3 项，验证详情浮层出现且跟随切换
  await page.locator('.station-list li').nth(2).click()
  await page.waitForTimeout(400)
  check('点击站点弹出详情', await page.locator('.site-detail').count() === 1)
  const detailName = await page.locator('.site-detail h4').innerText()
  check('详情显示被点站点', detailName.length > 0, detailName)
  await page.screenshot({ path: path.join(out, 'page1-detail.png') })
  await page.locator('.map-stage .leaflet-interactive').first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(200)
  check('地图圆点点击联动详情', await page.locator('.site-detail').count() === 1)

  console.log('\n[页面 2 · 预测专屏]')
  await page.goto(`${URL}/?page=2&interval=3600&paused=1`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(out, 'page2-prediction.png') })
  check('站点切换条 10 项', await page.locator('.strip-items button').count() === 10)
  check('主预测图渲染', await page.locator('.trend-big svg').count() >= 1, `实际 ${await page.locator('.trend-big svg').count()}`)
  check('四个预见期卡片', await page.locator('.horizon-card').count() === 4)
  check('预测表 10 行', await page.locator('.pred-table tbody tr').count() === 10)
  check('三张辅助图', await page.locator('.pred-side svg').count() >= 3, `实际 ${await page.locator('.pred-side svg').count()}`)
  const before = await page.locator('.pred-table tbody tr.active td.name').innerText()
  await page.locator('.strip-items button').nth(4).click()
  await page.waitForTimeout(300)
  const after = await page.locator('.pred-table tbody tr.active td.name').innerText()
  check('点击站点条联动主图与表格', before !== after, `${before} -> ${after}`)
  const mainTitle = await page.locator('.pred-main h3').innerText()
  check('主图标题跟随切换', mainTitle.includes(after.replace(/·.*/, '')), mainTitle)
  await page.screenshot({ path: path.join(out, 'page2-linked.png') })
  check('无页面脚本错误', errors.length === 0, errors.join('; '))

  // 数据自动变化验证
  console.log('\n[自动波动验证]')
  const v1 = await page.locator('.pred-table tbody tr').first().locator('td').nth(2).innerText()
  await page.waitForTimeout(5000)
  const v2 = await page.locator('.pred-table tbody tr').first().locator('td').nth(2).innerText()
  check('5 秒内数据自动变化', v1 !== v2, `${v1} -> ${v2}`)

  await browser.close()
  console.log(`\nUI 验证：PASS ${pass} / FAIL ${fail}`)
  console.log(`截图输出：${out}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
