import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const bundle = await build({
  entryPoints: ['src/lib/teleop-config.ts'], bundle: true,
  format: 'cjs', platform: 'node', write: false,
})
function config(location, runtime) {
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, URLSearchParams,
    window: { location, __LIVEKIT_INFRA_CONFIG__: runtime },
  })
  return module.exports.teleopConfig
}

test('unconfigured deployments stay on their own origin and have no inherited login identity', () => {
  const value = config({ origin: 'https://new-host.example', hostname: 'new-host.example',
    search: '?backend=https://other.test&livekit=wss://other.test&dev=1' })
  assert.equal(value.gatewayUrl, 'https://new-host.example')
  assert.equal(value.livekitUrl, 'wss://new-host.example')
  assert.equal(value.authorizeUrl, '')
  assert.equal(value.tokenUrl, '')
  assert.equal(value.clientId, '')
})

test('runtime configuration selects the deployment while query overrides remain loopback-only', () => {
  const location = { origin: 'http://localhost:8000', hostname: 'localhost',
    search: '?dev=1&backend=http://localhost:8080&livekit=ws://localhost:7880' }
  assert.equal(config(location).gatewayUrl, 'http://localhost:8080')
  const value = config(location, { gatewayUrl: 'https://api.example.test', clientId: 'new-client' })
  assert.equal(value.gatewayUrl, 'https://api.example.test')
  assert.equal(value.clientId, 'new-client')
})
