import React from 'react'
import { useMockFleet } from '../app/MockFleetProvider'
import { mapPercent } from '../lib/dashboard-data'

export default function DashboardMap({ vehicleId }: { vehicleId?: string }) {
  const { map, vehicles } = useMockFleet()
  if (!map) return null
  const [minX, minY, maxX, maxY] = map.bounds
  const points = (values: [number, number][]) => values.map(([x, y]) =>
    `${50 + (x - minX) / (maxX - minX) * 900},${50 + (maxY - y) / (maxY - minY) * 900}`).join(' ')
  const vehicle = vehicles.entries.find((entry) => entry.vehicle_id === vehicleId)
  const localization = vehicle?.state?.localization.message
  const position = localization?.position
  const marker = localization?.frame_id === map.frame_id && typeof position?.x === 'number' && typeof position.y === 'number'
    ? mapPercent(map, position.x, position.y) : undefined
  return <svg aria-label={`道路图 ${map.version}`} viewBox="0 0 1000 1000" preserveAspectRatio="none"
    className="absolute inset-0 w-full h-full">
    <g fill="none">
      {map.lanes.map((lane) => <g key={lane.id}>
        {[lane.left, lane.right].map((line, index) =>
          <polyline key={index} points={points(line)} stroke="#64748b" strokeWidth="1.5" />)}
        <polyline points={points(lane.center)} stroke="#38bdf8" strokeWidth="1" strokeDasharray="4 4" />
      </g>)}
    </g>
    {marker && <circle cx={marker.left} cy={marker.top} r="9" fill="#fbbf24" />}
  </svg>
}
