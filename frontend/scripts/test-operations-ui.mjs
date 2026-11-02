import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const base = new URL(process.env.FRONTEND_URL ?? 'http://localhost:8000/')
const profile = await mkdtemp(path.join(tmpdir(), 'operations-ui-'))
const chrome = spawn(process.env.CHROME_BIN ?? 'google-chrome', [
  '--headless=new', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--window-size=1600,1100', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket, launchError, chromeLog = ''
chrome.stderr.on('data', (data) => { chromeLog = (chromeLog + data.toString()).slice(-4000) })
chrome.on('error', (error) => { launchError = error })
try {
  let port
  for (let i = 0; i < 200; i++) {
    if (launchError) throw launchError
    if (chrome.exitCode !== null) throw new Error(`Chrome exited (${chrome.exitCode}): ${chromeLog}`)
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await wait(100)
    }
  }
  assert.ok(port, `Chrome did not start: ${chromeLog}`)
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map(), requests = [], errors = []
  let serial = 0
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
      else callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params
      const local = new URL(request.url).origin === base.origin && !/\/api\/|^wss?:/.test(request.url)
      void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(!local ? { errorReason: 'BlockedByClient' } : {}) })
    }
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return
      await wait(100)
    }
    throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`)
  }
  const click = async (text) => {
    await evaluate(`{ const b=[...document.querySelectorAll('button, aside nav div')].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(text)}); if(!b) throw Error('Missing button: '+${JSON.stringify(text)}); b.click(); }`)
    await wait(100)
  }
  const input = async (label, text) => {
    await evaluate(`{ const s=document.querySelector('input[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${JSON.stringify(text)}); s.dispatchEvent(new Event('input',{bubbles:true})); }`)
    await wait(100)
  }
  const press = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await wait(100)
  }
  const screenshot = async (name) => {
    if (!process.env.SCREENSHOT_DIR) return
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(process.env.SCREENSHOT_DIR, `${name}.png`), Buffer.from(image.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Page.enable')
  await send('Page.navigate', { url: base.href })
  await until(`document.querySelector('svg[aria-label="车辆位置地图"]') !== null`)
  assert.equal(await evaluate(`document.querySelectorAll('aside nav > div').length`), 4)
  assert.match(await evaluate('document.querySelector("aside").innerText'), /任务管理/)
  await click('任务管理')
  assert.match(await evaluate('document.body.innerText'), /任务列表/)
  assert.match(await evaluate('document.body.innerText'), /新建任务（演示表单）/)
  assert.match(await evaluate('document.body.innerText'), /运营任务未接入/)
  assert.match(await evaluate('document.body.innerText'), /结果未知 · 对账中/)
  assert.doesNotMatch(await evaluate('document.body.innerText'), /今日完成|下发与编排自动驾驶任务/)
  for (const label of ['保存为草稿', '下发任务']) {
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-testid="task-center"] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).disabled`), true)
  }
  await screenshot('task-center')

  await click('车辆监控')
  await input('搜索监控车辆', 'sim-004')
  await press('[data-testid="vehicle-monitor-list"] button[aria-label="查看 sim-004 告警"]')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="告警车辆"]').value`), 'sim-004')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="告警恢复状态"]').value`), 'all')
  await click('车辆详情')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('nav[aria-label="车辆详情页签"] button')].map(e=>e.textContent)`), ['实时', '健康状态', '车辆信息'])
  assert.equal(await evaluate(`document.querySelector('[data-testid="vehicle-monitor-detail"] [data-testid="vehicle-timeline"]')`), null)
  await click('健康状态')
  assert.match(await evaluate('document.body.innerText'), /模拟底盘故障|模拟故障/)
  await click('← 返回告警处置')
  await press('[data-testid="vehicle-timeline"] + details > summary')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 800, deviceScaleFactor: 1, mobile: false })
  await wait(200)
  await evaluate(`document.querySelector('[data-testid="vehicle-timeline"]').parentElement.scrollTop=100`)
  const expandedScroll = await evaluate(`document.querySelector('[data-testid="vehicle-timeline"]').parentElement.scrollTop`)
  assert.ok(expandedScroll > 0, 'Exercise an actual scrolling alert work area')
  await click('车辆详情')
  await click('← 返回告警处置')
  assert.equal(await evaluate(`document.querySelector('[data-testid="vehicle-timeline"]').parentElement.scrollTop`), expandedScroll)
  assert.equal(await evaluate(`document.querySelector('[data-testid="vehicle-timeline"] + details').open`), true)
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
  await input('搜索车辆或事件', 'mock-3-battery-raised')
  await click('最早在前')
  await evaluate(`{ const s=document.querySelector('[data-testid="vehicle-timeline"]'); s.parentElement.scrollTop=100; }`)
  const alertScroll = await evaluate(`document.querySelector('[data-testid="vehicle-timeline"]').parentElement.scrollTop`)
  await click('车辆详情')
  await click('← 返回告警处置')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="搜索车辆或事件"]').value`), 'mock-3-battery-raised')
  assert.equal(await evaluate(`document.querySelector('[data-testid="vehicle-timeline"]').parentElement.scrollTop`), alertScroll)
  assert.equal(await evaluate(`document.querySelector('select[aria-label="告警车辆"]').value`), 'sim-004')
  assert.equal(await evaluate(`!![...document.querySelectorAll('[data-testid="vehicle-timeline"] button')].find(b=>b.textContent==='最新在前')`), true)
  await click('车辆详情')
  await click('实时')
  await press('button[aria-label="进入 sim-004 远程驾驶监看"]')
  await until(`document.querySelector('[data-testid="remote-driving-workbench"] h1')?.textContent.includes('sim-004')`)
  assert.match(await evaluate('document.body.innerText'), /网络质量未知 · 未测量/)
  assert.doesNotMatch(await evaluate('document.body.innerText'), /信号优秀|信号良好/)
  assert.equal(await evaluate(`document.querySelector('svg[aria-label="跟车局部 BEV"]').getAttribute('data-stale')`), 'false')
  await click('全屏查看')
  assert.match(await evaluate('document.body.innerText'), /sim-004 · 全屏监看 · 不可控制/)
  await click('退出全屏')

  await click('远程驾驶')
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="remote-driving-list"] tbody tr').length`), 8)
  assert.equal(await evaluate(`document.querySelector('[data-testid="remote-driving-workbench"]')`), null)
  assert.equal(await evaluate(`!![...document.querySelectorAll('[data-testid="remote-driving-list"] button')].find(b=>b.textContent.trim()==='进入工作台')`), false)
  await screenshot('remote-driving-list')
  await input('搜索远程驾驶车辆', 'sim-007')
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="remote-driving-list"] tbody tr').length`), 1)
  await click('离线')
  await press('[data-testid="remote-driving-list"] tbody tr td:last-child')
  assert.match(await evaluate('document.body.innerText'), /车辆离线，不能确认当前状态/)
  await wait(300)
  await screenshot('remote-driving-offline')
  assert.equal(await evaluate(`document.querySelector('svg[aria-label="跟车局部 BEV"]').getAttribute('data-stale')`), 'true')
  const road = await evaluate(`document.querySelector('svg[aria-label="跟车局部 BEV"] polyline').getAttribute('points')`)
  await wait(650)
  assert.equal(await evaluate(`document.querySelector('svg[aria-label="跟车局部 BEV"] polyline').getAttribute('points')`), road)
  await click('返回远程驾驶列表')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="搜索远程驾驶车辆"]').value`), 'sim-007')
  await input('搜索远程驾驶车辆', 'no-match')
  assert.match(await evaluate('document.body.innerText'), /没有匹配车辆/)
  await input('搜索远程驾驶车辆', '')
  await click('全部')
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 500, deviceScaleFactor: 1, mobile: false })
  await wait(200)
  await evaluate(`document.querySelector('[data-testid="remote-driving-list"] section').scrollTop=180`)
  await wait(100)
  const listScroll = await evaluate(`document.querySelector('[data-testid="remote-driving-list"] section').scrollTop`)
  assert.ok(listScroll > 0)
  await press('[data-testid="remote-driving-list"] tbody tr:nth-child(3) td:nth-child(3)')
  assert.match(await evaluate('document.body.innerText'), /主视角 · 后视摄像头/)
  assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  await click('返回远程驾驶列表')
  assert.equal(await evaluate(`document.querySelector('[data-testid="remote-driving-list"] section').scrollTop`), listScroll)
  await send('Page.bringToFront')
  await evaluate(`document.querySelector('button[aria-label="进入 sim-002 工作台"]').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector('[data-testid="remote-driving-workbench"] h1')?.textContent.includes('sim-002')`)
  await click('任务管理')
  assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="task-center"] select')[1].options.length`), 8)
  await click('车辆监控')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="搜索监控车辆"]').value`), 'sim-004')
  await click('车队总览')
  await press('button[aria-label="选中 sim-002"]')
  await click('远程驾驶')
  assert.ok(await evaluate(`document.querySelector('[data-testid="remote-driving-list"]') !== null`))
  await press('button[aria-label="进入 sim-003 工作台"]')
  assert.match(await evaluate(`document.querySelector('[data-testid="remote-driving-workbench"] h1').textContent`), /sim-003/)
  await click('查看车辆监控')
  assert.equal(await evaluate(`document.querySelector('[data-testid="vehicle-monitor-detail"] h1').textContent`), 'sim-003')
  assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  await click('车队总览')
  await press('button[aria-label="查看待恢复告警"]')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="告警恢复状态"]').value`), 'pending')
  assert.equal(requests.some((url) => /\/api\/|^wss?:/.test(url)), false)
  assert.deepEqual(errors, [])
  console.log('Passed: restored read-only task page, remote whole-row and keyboard entry, single alert workspace, contextual return, separate list state, same-car camera entry, offline BEV, unknown network, reverse camera, fullscreen identity, responsive layout and no control/API requests.')
} finally {
  socket?.close()
  if (chrome.pid && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await exited
  }
  await rm(profile, { recursive: true, force: true })
}
