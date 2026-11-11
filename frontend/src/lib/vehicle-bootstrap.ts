import { z } from 'zod'

const endpoint = z.string().max(2048).url().refine(value => {
  try {
    const url = new URL(value)
    const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    return (url.protocol === 'https:' || local) && !url.username && !url.password && url.port !== '0'
      && !/[\s?#]/.test(value) && !/^https:\/\/[^/]*@/.test(value)
  } catch { return false }
}, '请使用不含凭据、查询参数或片段的 HTTPS 地址')
export const vehicleSetupDefaultsSchema = z.object({
  gateway_url: endpoint, console_url: endpoint,
})
export type VehicleSetupDefaults = z.infer<typeof vehicleSetupDefaultsSchema>
export const vehicleBootstrapInputSchema = z.object({
  gateway_url: endpoint, console_url: endpoint,
}).strict()

export function vehicleBootstrapJSON(input: unknown): string {
  const value = vehicleBootstrapInputSchema.parse(input)
  return JSON.stringify({
    ...value,
    state_directory: '/var/lib/teleop/bootstrap',
    device_template: '/etc/teleop/device.template.json',
    device_config: '/etc/teleop/device.json',
    allow_insecure_localhost: value.gateway_url.startsWith('http:') || value.console_url.startsWith('http:'),
    allow_legacy_complete_404: false,
  }, null, 2)
}
