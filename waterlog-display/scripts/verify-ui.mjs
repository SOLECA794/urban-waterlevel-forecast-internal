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

  console.log('\n[页面 1 · 全域态势]')
  await page.goto(`${URL}/?page=1`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(out, 'page1-overview.png') })
  check('标题渲染', await page.locator('.brand h1').innerText().then(t => t.includes('黄岩区')))
  check('三栏布局：左中右', await page.locator('.left-side').count() === 1 && await page.locator('.map-stage').count() === 1 && await page.locator('.right-side').count() === 1)
  check('站点列表 10 项', await page.locator('.station-list li').count() === 10, `实际 ${await page.locator('.station-list li').count()}`)
  check('日历渲染', await page.locator('.calendar .cal-cell').count() > 25)
  check('预警列表有数据', await page.locator('.alert-list li').count() > 0)
  check('地图圆点可点击', await page.locator('.leaflet-interactive').count() >= 10, `实际 ${await page.locator('.leaflet-interactive').count()}`)
  check('联动站点速览卡', await page.locator('.link-focus').count() === 1)
  check('页面不自动换页（无轮播进度条）', await page.locator('.rotation-progress').count() === 0)
  check('无页面脚本错误', errors.length === 0, errors.join('; '))

  await page.locator('.station-list li').nth(2).click()
  await page.waitForTimeout(350)
  check('点击站点弹出详情', await page.locator('.site-detail').count() === 1)
  const detailName = await page.locator('.site-detail h4').innerText()
  check('详情显示被点站点', detailName.length > 0, detailName)
  const linkText = await page.locator('.link-focus').innerText()
  check('速览卡与详情联动', linkText.includes(detailName.replace(/·.*/, '')), linkText.slice(0, 40))
  await page.screenshot({ path: path.join(out, 'page1-detail.png') })
  await page.locator('.map-stage .leaflet-interactive').first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(200)
  check('地图圆点点击联动详情', await page.locator('.site-detail').count() === 1)

  // 手动换页：点击 tab，不自动
  console.log('\n[手动换页验证]')
  await page.locator('.tabs button').nth(1).click()
  await page.waitForTimeout(500)
  check('点击 tab 进入预测专屏', await page.locator('.prediction-page').count() === 1)
  check('换页需要手动点击', await page.locator('.page-1').count() === 1)

  console.log('\n[页面 2 · 预测专屏]')
  await page.screenshot({ path: path.join(out, 'page2-prediction.png') })
  check('站点切换条 10 项', await page.locator('.strip-items button').count() === 10)
  check('主预测图渲染', await page.locator('.trend-big svg').count() >= 1, `实际 ${await page.locator('.trend-big svg').count()}`)
  check('三个尺度预见期卡片 3/6/12h', await page.locator('.horizon-card').count() === 3)
  check('三尺度区间图渲染', await page.locator('.interval-chart svg').count() >= 1)
  check('十站风险热力矩阵 10 行', await page.locator('.risk-heat-row').count() === 10)
  check('十站时段涨落矩阵 10 行', await page.locator('.hm-row').count() === 10)
  check('十站预测微图 10 张', await page.locator('.mini-card').count() === 10)
  check('三张辅助图', await page.locator('.pred-side svg').count() >= 3, `实际 ${await page.locator('.pred-side svg').count()}`)
  check('纯数据表已移除', await page.locator('.pred-table').count() === 0)
  check('无页面脚本错误', errors.length === 0, errors.join('; '))

  const before = await page.locator('.pred-main h3').innerText()
  await page.locator('.strip-items button').nth(4).click()
  await page.waitForTimeout(300)
  const after = await page.locator('.pred-main h3').innerText()
  check('点击站点条联动主图', before !== after, `${before} -> ${after}`)
  const activeMini = await page.locator('.mini-card.active .mini-head').innerText()
  check('微图矩阵联动高亮', activeMini.length > 0, activeMini)
  const activeHeat = await page.locator('.risk-heat-row.active .rh-name').innerText()
  check('风险矩阵联动高亮', activeHeat.length > 0, activeHeat)
  await page.locator('.mini-card').nth(7).click()
  await page.waitForTimeout(250)
  const afterMini = await page.locator('.pred-main h3').innerText()
  check('点击微图联动主图', afterMini !== after, `${after} -> ${afterMini}`)
  await page.screenshot({ path: path.join(out, 'page2-linked.png') })

  console.log('\n[自动波动验证]')
  const v1 = await page.locator('.strip-items button').first().locator('small').innerText()
  await page.waitForTimeout(5000)
  const v2 = await page.locator('.strip-items button').first().locator('small').innerText()
  check('5 秒内数据自动波动', v1 !== v2, `${v1} -> ${v2}`)

  await browser.close()
  console.log(`\nUI 验证：PASS ${pass} / FAIL ${fail}`)
  console.log(`截图输出：${out}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
