import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function protobufString(token) {
  const text = token.slice(1, -1), bytes = []
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63 }
  let end = 0
  for (const match of text.matchAll(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|[abfnrtv\\?'"])|[^\\]+/g)) {
    if (match.index !== end) throw new Error('Invalid protobuf string escape')
    if (match[1]) {
      const escape = match[1]
      const byte = /^[0-7]/.test(escape) ? parseInt(escape, 8)
        : escape.startsWith('x') ? parseInt(escape.slice(1), 16) : escapes[escape]
      if (byte > 255) throw new Error('Invalid protobuf byte escape')
      bytes.push(Buffer.from([byte]))
    } else bytes.push(Buffer.from(match[0], 'utf8'))
    end = match.index + match[0].length
  }
  if (end !== text.length) throw new Error('Invalid protobuf string')
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes))
}

// Apollo text protobuf preserves the sampled curves; editor points alone do not.
export function parseMapText(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}:]|[^\s{}:]+/g) ?? []
  let index = 0
  const message = (nested = false) => {
    const result = {}
    while (index < tokens.length && tokens[index] !== '}') {
      const key = tokens[index++]
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid map field: ${key}`)
      const separator = tokens[index++]
      let value
      if (separator === '{') {
        value = message(true)
      } else if (separator === ':') {
        const token = tokens[index++]
        if (token === undefined) throw new Error('Missing map value')
        value = token.startsWith('"') ? protobufString(token)
          : /^[-+]?(?:\d|\.\d)/.test(token) ? Number(token) : token
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid map number')
      } else {
        throw new Error(`Invalid map separator: ${separator}`)
      }
      ;(result[key] ??= []).push(value)
    }
    if (nested && tokens[index++] !== '}') throw new Error('Unclosed map message')
    return result
  }
  const result = message()
  if (index !== tokens.length) throw new Error('Unexpected map closing brace')
  return result
}

export function convertMap(text, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error('Invalid map ID')
  const root = parseMapText(text)
  const curve = (value) => (value?.segment ?? []).flatMap((segment) =>
    (segment.line_segment ?? []).flatMap((line) => (line.point ?? []).map((point) => {
      const x = point.x?.[0], y = point.y?.[0]
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid curve coordinates')
      return [x, y]
    })))
  const lanes = (root.lane ?? []).map((lane) => ({
    id: lane.id?.[0]?.id?.[0],
    center: curve(lane.central_curve?.[0]),
    left: curve(lane.left_boundary?.[0]?.curve?.[0]),
    right: curve(lane.right_boundary?.[0]?.curve?.[0]),
  })).filter((lane) => lane.center.length >= 2)
  if (!lanes.length || lanes.some((lane) => typeof lane.id !== 'string')) {
    throw new Error('Map has no valid named lane curves')
  }
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  for (const lane of lanes) for (const points of [lane.center, lane.left, lane.right]) {
    for (const [x, y] of points) {
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y)
      bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y)
    }
  }
  return {
    schema_version: 1, id, version: String(root.header?.[0]?.version?.[0] ?? id),
    frame_id: `map:${id}`, units: 'meters', bounds, lanes,
  }
}

async function main() {
  const args = process.argv.slice(2)
  let source
  const maps = []
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--source') source = args[i + 1]
    else if (args[i] === '--map') maps.push(args[i + 1])
    else throw new Error(`Unknown option: ${args[i]}`)
  }
  if (!source || !maps.length) throw new Error('Usage: npm run prepare:maps -- --source PATH --map MAP_DIRECTORY [--map MAP_DIRECTORY]')
  const root = await realpath(source)
  const output = fileURLToPath(new URL('../public/maps/', import.meta.url))
  const converted = []
  for (const id of maps) {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error('Invalid map directory')
    const filename = await realpath(path.join(root, id, 'base_map.txt'))
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('Map escapes source directory')
    const text = await readFile(filename, 'utf8')
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Map exceeds 32 MiB conversion limit')
    converted.push(convertMap(text, id))
  }
  await mkdir(output, { recursive: true })
  for (const map of converted) {
    await writeFile(path.join(output, `${map.id}.json`), JSON.stringify(map))
    console.log(`${map.id}: ${map.lanes.length} lanes`)
  }
  await writeFile(path.join(output, 'index.json'), JSON.stringify({
    maps: converted.map(({ id, version }) => ({ id, version })),
  }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
