import { z } from 'zod'

const endpoint = z.string().max(2048).url().refine(value => {
  try {
    const url = new URL(value)
    const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    return (url.protocol === 'https:' || local) && !url.username && !url.password && url.port !== '0'
      && !/[\s?#]/.test(value) && !/^https:\/\/[^/]*@/.test(value)
  } catch { return false }
}, '请使用不含凭据、查询参数或片段的 HTTPS 地址')
const text = (limit: number) => z.string().trim().min(1, '请填写车辆信息')
  .refine(value => !/[\x00-\x1f\x7f]/.test(value) && new TextEncoder().encode(value).length <= limit, '字段包含控制字符或过长')

export const vehicleSetupDefaultsSchema = z.object({
  gateway_url: endpoint, console_url: endpoint, platform: text(128),
})
export type VehicleSetupDefaults = z.infer<typeof vehicleSetupDefaultsSchema>
export const vehicleBootstrapInputSchema = z.object({
  gateway_url: endpoint, console_url: endpoint,
  name: text(200), serial: z.union([z.literal(''), text(128)]).default(''), platform: text(128),
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
