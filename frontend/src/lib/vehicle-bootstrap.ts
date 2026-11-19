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
  gateway_url: endpoint,
}).strict()

export function vehicleBootstrapJSON(input: unknown): string {
  const value = vehicleBootstrapInputSchema.parse(input)
  const localTest = value.gateway_url.startsWith('http:')
  return JSON.stringify({
    ...value,
    ...(localTest ? { allow_insecure_localhost: true } : {}),
  }, null, 2)
}
