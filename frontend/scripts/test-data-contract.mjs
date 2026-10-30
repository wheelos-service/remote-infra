import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

assert.ok(process.argv[2], 'Usage: node scripts/test-data-contract.mjs <C++/Gateway fixture.json>')
globalThis.window = { location: { hostname: 'localhost', search: '' }, __LIVEKIT_INFRA_CONFIG__: undefined }
const { outputFiles } = await build({
  entryPoints: ['src/lib/vehicle-data-api.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
})
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'))
const data = api.vehicleDataSchema.parse(fixture.data)
assert.equal(data.vehicle_id, 'car-1')
assert.ok(data.health?.payload.sample.message)
assert.ok(data.diagnostics?.payload.store.outbox_retained > 0)
assert.equal(data.tasks[0].result.status, 'succeeded')
assert.equal(data.tasks[0].result.report_sequence, 3)
assert.equal(data.can_manage, false)
for (const kind of ['events', 'tasks']) {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json(fixture[kind])
    const records = (await api.exportDataRecords('car-1', kind, 'fixture-bearer')).split('\n').map(JSON.parse)
    assert.equal(records.length, kind === 'events' ? 4 : 1)
  } finally { globalThis.fetch = original }
}
console.log('PASS actual C++ diagnostics/health/events/tasks -> Gateway HTTP -> frontend strict parsers/export')
