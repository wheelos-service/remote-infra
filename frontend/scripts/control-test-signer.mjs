// Loopback-only acceptance helper. It uses the shipped browser signing code,
// never a production key or token. Not included in the frontend build.
import { createServer } from 'node:http'
import { webcrypto } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { build } from 'esbuild'

globalThis.crypto ??= webcrypto
const result = await build({
  entryPoints: ['src/lib/control-protocol.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node',
})
const { signControl, base64, controlFeedbackSchema } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))

if (process.argv[2] === '--vector') {
  const child = spawn(process.argv[3], ['--vector'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })
  const session = {
    session_id: 'session-test', vehicle_id: 'car-test', protocol_version: 2,
    client_instance_id: 'browser-test', sender_identity: 'control-session-test',
    status: 'ACTIVE', public_key_b64: publicKey,
  }
  child.stdin.write(JSON.stringify({
    vehicle_id: 'car-test', revision: 1, state: 'ACTIVE', session_id: session.session_id,
    ttl_ms: 10000, simulation: true, session,
  }) + '\n')
  let count = 0
  for await (const line of lines) {
    const feedback = controlFeedbackSchema.parse(JSON.parse(line))
    if (++count === 1) {
      child.stdin.end(await signControl(pair.privateKey, {
        version: 2, type: 'control', vehicle_id: 'car-test', session_id: session.session_id,
        client_instance_id: 'browser-test', receiver_instance_id: feedback.receiver_instance_id,
        revision: 1, sequence: 1, timestamp_ms: 1700000000000,
        command: { steering: -1000, throttle: 1000, brake: 0, direction: -1 },
      }) + '\n')
    } else if (feedback.status !== 'APPLIED') throw new Error('SDK rejected frontend signature')
  }
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0 || count !== 2) throw new Error('Cross-language verification failed')
  console.log('Frontend WebCrypto -> C++ Ed25519 verification passed')
} else {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/public') {
        response.end(JSON.stringify({ public_key_b64: publicKey }))
        return
      }
      if (request.method !== 'POST' || request.url !== '/sign') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 2048) throw new Error('oversize')
      }
      response.end(await signControl(pair.privateKey, JSON.parse(body)))
    } catch {
      response.writeHead(400).end('invalid test payload')
    }
  })
  server.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ signer_url: `http://127.0.0.1:${server.address().port}` }))
  })
  process.on('SIGTERM', () => server.close())
}
