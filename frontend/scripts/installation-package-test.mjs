import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as esbuild from 'esbuild'

const bundle = await esbuild.build({ entryPoints: ['src/lib/installation-package.ts'], bundle: true, format: 'esm', platform: 'node', write: false })
const { buildInstallationPackage, downloadInstallationPackage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const operation = '11111111-1111-4111-8111-111111111111'
const ticket = { token: 'fixture-ticket', expires_at: new Date(Date.now() + 300000).toISOString() }

test('installation packages bind public metadata and reject unsafe destinations and expiry', () => {
  const value = JSON.parse(buildInstallationPackage(ticket, 'car-1', operation, 'https://gateway.example/'))
  assert.deepEqual(Object.keys(value).sort(), ['schema_version', 'gateway_url', 'vehicle_id', 'operation_id', 'expires_at', 'installation_ticket'].sort())
  assert.equal(value.installation_ticket, ticket.token)
  for (const gateway of ['http://remote.example', 'https://u:p@gateway.example', 'https://gateway.example/path', 'https://gateway.example/?secret=x']) {
    assert.throws(() => buildInstallationPackage(ticket, 'car-1', operation, gateway))
  }
  assert.throws(() => buildInstallationPackage(ticket, '../file', operation, 'https://gateway.example'))
  assert.throws(() => buildInstallationPackage({ ...ticket, expires_at: '2000-01-01T00:00:00Z' }, 'car-1', operation, 'https://gateway.example'))
})

test('package download cleans up its object URL even if clicking fails', () => {
  const originalDocument = globalThis.document
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  const revoked = []
  let removed = 0
  let link
  URL.createObjectURL = () => 'blob:fixture'
  URL.revokeObjectURL = value => revoked.push(value)
  globalThis.document = { body: { append() {} }, createElement() {
    link = { remove() { removed++ }, click() { throw new Error('download failed') } }
    return link
  } }
  try {
    assert.throws(() => downloadInstallationPackage('{}', '../car'))
    assert.equal(link.download, '.._car-enrollment.json')
    assert.equal(removed, 1)
    assert.deepEqual(revoked, ['blob:fixture'])
  } finally {
    globalThis.document = originalDocument
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  }
})
