import { CameraView } from '../../../apps/operator-console/src/lib/camera-view'
export { CameraView }
export type { ViewMode } from '../../../apps/operator-console/src/lib/camera-view'

export const cameras = [
  { name: 'front', label: '前视（单路）' },
  { name: 'left', label: '前左' }, { name: 'center', label: '前中' }, { name: 'right', label: '前右' },
  { name: 'rear-left', label: '后左' }, { name: 'rear-center', label: '后中' }, { name: 'rear-right', label: '后右' },
] as const
export type CameraName = typeof cameras[number]['name']

export function trackCameraName(trackName: string): CameraName | undefined {
  const normalized = trackName === 'camera' || trackName === 'camera0'
    ? 'front' : trackName.replace(/^camera-/, '')
  return cameras.find(({ name }) => name === normalized)?.name
}

export function visibleCameras(group: 'front' | 'rear', available: Partial<Record<CameraName, unknown>>) {
  const single = available.front && !available.left && !available.center && !available.right
  return cameras.filter(({ name }) => group === 'rear' ? name.startsWith('rear-')
    : single ? name === 'front' : name !== 'front' && !name.startsWith('rear-'))
}
