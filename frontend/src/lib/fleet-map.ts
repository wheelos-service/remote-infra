import { z } from 'zod'

const mapId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
const point = z.tuple([z.number().finite(), z.number().finite()])
export const mapCatalogSchema = z.object({
  maps: z.array(z.object({ id: mapId, version: z.string().max(128) }).strict()).min(1).max(100),
}).strict().refine((value) => new Set(value.maps.map((map) => map.id)).size === value.maps.length)
export const fleetMapSchema = z.object({
  schema_version: z.literal(1), id: mapId, version: z.string().max(128),
  frame_id: z.string().max(128), units: z.literal('meters'),
  bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  lanes: z.array(z.object({
    id: z.string().min(1).max(128),
    center: z.array(point).min(2).max(50_000),
    left: z.array(point).max(50_000), right: z.array(point).max(50_000),
  }).strict()).min(1).max(10_000),
}).strict().superRefine((map, ctx) => {
  const [minX, minY, maxX, maxY] = map.bounds
  if (minX >= maxX || minY >= maxY || map.frame_id !== `map:${map.id}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Map frame or bounds invalid' })
  }
  const ids = new Set<string>()
  for (const lane of map.lanes) {
    if (ids.has(lane.id) || !lane.center.some(([x, y]) => x !== lane.center[0][0] || y !== lane.center[0][1])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate or zero-length lane' })
    }
    ids.add(lane.id)
    for (const [x, y] of [...lane.center, ...lane.left, ...lane.right]) {
      if (x < minX || x > maxX || y < minY || y > maxY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Geometry outside map bounds' })
      }
    }
  }
})
export type FleetMap = z.infer<typeof fleetMapSchema>
export type MapCatalog = z.infer<typeof mapCatalogSchema>

export function lanePosition(points: [number, number][], distance: number) {
  if (!Number.isFinite(distance) || distance < 0) throw new Error('Invalid route distance')
  const lengths = points.slice(1).map(([x, y], i) => Math.hypot(x - points[i][0], y - points[i][1]))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (!Number.isFinite(total) || total <= 0) throw new Error('Route has no length')
  let remaining = distance % total
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] === 0) continue
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const [x, y] = points[i], [endX, endY] = points[i + 1]
      const ratio = remaining / lengths[i]
      return { x: x + (endX - x) * ratio, y: y + (endY - y) * ratio, heading: Math.atan2(endY - y, endX - x) }
    }
    remaining -= lengths[i]
  }
  throw new Error('Route position unavailable')
}
