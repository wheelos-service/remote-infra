import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const fixturePath = process.argv[2]
assert.ok(fixturePath, 'Usage: node scripts/test-platform-contract.mjs <Gateway corpus.json>')
globalThis.window = {
  location: { hostname: 'localhost', search: '' },
  __LIVEKIT_INFRA_CONFIG__: undefined,
}
const { outputFiles } = await build({
  entryPoints: [
    'src/lib/vehicles-api.ts',
    'src/lib/vehicle-operations-api.ts',
    'src/lib/vehicle-telemetry.ts',
    'src/lib/preview-vehicles.ts',
  ],
  outdir: 'contract-build',
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
async function load(name) {
  const file = outputFiles.find(({ path }) => path.endsWith(`/${name}.js`))
  assert.ok(file)
  return import(`data:text/javascript;base64,${Buffer.from(file.contents).toString('base64')}`)
}
const api = await load('vehicles-api')
const operations = await load('vehicle-operations-api')
const telemetry = await load('vehicle-telemetry')
const preview = await load('preview-vehicles')
const corpus = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.ok(corpus.length >= 16, 'Incomplete Gateway scenario corpus')
for (const scenario of corpus) {
  const { name, expected } = scenario
  const entry = api.vehicleEntrySchema.parse(scenario.entry)
  const directory = api.vehiclesResponseSchema.parse(scenario.directory)
  const business = operations.vehicleOperationsSchema.parse(scenario.operations)
  assert.deepEqual(directory.vehicles.find(({ vehicle_id }) => vehicle_id === entry.vehicle_id), entry, name)
  const received = { ...entry, receivedAtClientMs: 1000, receivedAtWallMs: entry.server_time_ms }
  assert.equal(telemetry.directoryOnline(received, false, 1000), expected.online, name)
  assert.equal(telemetry.getSampleFreshness(entry.state?.chassis, received, 1000).state, expected.freshness, name)
  assert.equal(business.vehicle_id, entry.vehicle_id, name)
  assert.deepEqual(business.capabilities, { mission_commands: false, geographic_projection: false, driving: false }, name)
  if ('speed' in expected) assert.equal(entry.state.chassis.message.speed_mps, expected.speed, name)
  if ('gear' in expected) assert.equal(entry.state.chassis.message.gear_location, expected.gear, name)
  if ('history' in expected) assert.equal(business.history.length, expected.history, name)
  for (const [field, status] of [['open_alerts', 'open'], ['resolved_alerts', 'resolved']]) {
    if (field in expected) assert.equal(business.alerts.filter((a) => a.status === status).length, expected[field], name)
  }
  if (expected.issue) assert.ok(business.diagnostics.issues.some((i) => i.code === expected.issue), name)
  if (expected.mission) assert.equal(business.missions[0].status, expected.mission, name)
  if (expected.marker) assert.ok(
    operations.recentHistoryWithMarkers(business.history, 300).some((item) => item.marker?.kind === expected.marker), name,
  )
  console.log(`PASS ${name}`)
}
console.log(`Gateway -> frontend: ${corpus.length} mock scenarios passed`)
const previewCorpus = []
for (const scenario of preview.previewScenarios) {
  for (const { receivedAtClientMs, receivedAtWallMs, ...entry } of preview.createPreviewVehicles(undefined, scenario).entries) {
    previewCorpus.push({
      name: `preview-${scenario}-${entry.vehicle_id}`,
      entry,
      operations: operations.createPreviewOperations(entry.vehicle_id, undefined, scenario),
    })
  }
}
if (process.argv[3]) {
  await writeFile(process.argv[3], JSON.stringify([...corpus, ...previewCorpus]), { mode: 0o600 })
}
