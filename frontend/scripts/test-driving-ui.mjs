import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const base = new URL(process.env.DRIVING_UI_URL)
assert.equal(base.hostname, 'localhost', 'Only a disposable localhost fixture is allowed')
const profile = await mkdtemp(path.join(tmpdir(), 'driving-ui-'))
const chrome = spawn(process.env.CHROME_BIN ?? 'google-chrome', [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-extensions',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--window-size=1600,1000', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket, launchError, log = ''
chrome.on('error', error => { launchError = error })
chrome.stderr.on('data', data => { log = (log + data.toString()).slice(-4000) })
let cleanupTask
const cleanup = () => cleanupTask ??= (async () => {
  socket?.close()
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM')
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), wait(3000)])
    if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await new Promise(resolve => chrome.once('exit', resolve)) }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})()
process.once('SIGTERM', async () => { await cleanup(); process.exit(143) })
try {
  let port
  for (let i = 0; i < 300; i++) {
    if (launchError) throw launchError
    if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chrome exited: ${log}`)
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await wait(100)
    }
  }
  assert.ok(port, `Chrome startup timed out: ${log}`)
  console.log('Chrome ready')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find(value => value.type === 'page' && value.url === 'about:blank') ?? targets.find(value => value.type === 'page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let serial = 0
  const pending = new Map(), exceptions = [], requests = []
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, method === 'Page.navigate' ? 30000 : 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id)
      if (!callback) return
      pending.delete(message.id)
      clearTimeout(callback.timer)
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
      else callback.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text)
    else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return
      await wait(100)
    }
    throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`)
  }
  const click = async text => {
    await evaluate(`{ const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!b || b.disabled) throw Error('Unavailable: '+${JSON.stringify(text)}+'\\n'+document.body.innerText); b.click(); }`)
    await wait(100)
  }
  const command = `JSON.parse(document.querySelector('[data-testid="control-feedback"]').dataset.command || 'null')`
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.prompt=()=> 'controller'; window.__testPad=null; Object.defineProperty(navigator,'getGamepads',{value:()=> window.__testPad ? [window.__testPad] : []});` })
  await send('Page.navigate', { url: base.href })
  await until(`document.body?.innerText.includes('本机开发令牌登录')`)
  console.log('Live route ready')
  assert.equal(requests.some(url => url.includes('/viewing/acquire') || url.includes('/control/acquire')), false)
  await click('本机开发令牌登录')
  await until(`document.body.innerText.includes('Second')`)
  console.log('Authorized directory ready')
  await evaluate(`{ const row=[...document.querySelectorAll('section > div')].find(e=>e.textContent.includes('car-2')); row.querySelector('button').click(); }`)
  await until(`document.querySelectorAll('[data-camera] video').length===3`)
  await until(`[...document.querySelectorAll('[data-camera] video')].every(v=>v.readyState>=2 && !v.classList.contains('invisible'))`)
  console.log('Three C++ camera streams decoded')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-camera]')].map(e=>e.dataset.camera)`), ['left', 'center', 'right'])
  assert.equal(requests.filter(url => url.includes('/viewing/acquire')).length, 1)
  await click('申请模拟控制权')
  await until(`document.body.innerText.includes('状态：ready')`)
  console.log('Control receiver READY')
  await click('启用键盘 WASD / 方向键')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await until(`(${command})?.throttle===1000`)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await until(`(${command})?.brake===1000 && (${command})?.throttle===0`)
  console.log('Signed keyboard request and release acknowledged')
  await evaluate(`window.__testPad={index:0,id:'Disposable Standard Pad',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:16},()=>({pressed:false,touched:false,value:0}))}`)
  await until(`document.body.innerText.includes('Disposable Standard Pad')`)
  await click('确认标准映射')
  await until(`! [...document.querySelectorAll('button')].find(b=>b.textContent==='启用手柄').disabled`)
  await click('启用手柄')
  await wait(200)
  await evaluate(`window.__testPad.buttons[4]={pressed:true,value:1}; window.__testPad.axes[3]=-0.5; window.__testPad.axes[0]=0.4`)
  await until(`(${command})?.throttle>0 && (${command})?.throttle<1000 && (${command})?.steering>0`)
  console.log('Signed proportional gamepad request acknowledged')
  await evaluate(`window.__testPad.buttons[4]={pressed:false,value:0}; window.__testPad.axes[3]=0; window.__testPad.axes[0]=0`)
  await until(`(${command})?.brake===1000 && (${command})?.throttle===0`)
  await click('放大中间')
  await click('全屏查看')
  assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='模拟制动（Space）' && b.getClientRects().length)`), true)
  await click('退出全屏')
  await evaluate(`document.querySelector('[data-camera="left"] video').pause()`)
  await until(`document.body.innerText.includes('状态：locked')`)
  await evaluate(`document.querySelector('[data-camera="left"] video').play()`)
  await until(`!document.querySelector('[data-camera="left"] video').classList.contains('invisible')`)
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='启用键盘 WASD / 方向键').disabled`), true)
  await click('释放并等待模拟交接')
  await until(`document.body.innerText.includes('状态：closed')`)
  await click('断开监看并返回列表')
  assert.equal(await evaluate(`document.querySelectorAll('[data-camera] video').length`), 0)
  assert.deepEqual(exceptions, [])
  console.log('PASS: three decoded C++ tracks, signed keyboard/gamepad v2 feedback, video-loss lock, handover and cleanup')
} catch (error) {
  console.error(error)
  throw error
} finally {
  await cleanup()
}
