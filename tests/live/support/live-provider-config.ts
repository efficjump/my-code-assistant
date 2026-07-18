import { z } from 'zod'

export interface LiveResponsesProviderConfig {
  baseUrl: string
  model: string
  apiKey: string | null
  iterations: number
  timeoutMs: number
}

const liveResponsesEnvironmentSchema = z
  .object({
    RESPONSES_LIVE_BASE_URL: z.string().url().max(2_048),
    RESPONSES_LIVE_MODEL: z.string().trim().min(1).max(512),
    RESPONSES_LIVE_API_KEY: z.string().max(16_384).optional(),
    RESPONSES_LIVE_ITERATIONS: z.coerce.number().int().min(1).max(100),
    RESPONSES_LIVE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(10 * 60_000),
  })
  .strict()

function secureProviderUrl(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'RESPONSES_LIVE_BASE_URL must use HTTPS or loopback HTTP without URL credentials.',
    )
  }
  return value.replace(/\/+$/, '')
}

export function loadLiveResponsesProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LiveResponsesProviderConfig | null {
  if (environment.RUN_LIVE_RESPONSES_EVALS !== '1') return null
  const parsed = liveResponsesEnvironmentSchema.parse({
    RESPONSES_LIVE_BASE_URL: environment.RESPONSES_LIVE_BASE_URL,
    RESPONSES_LIVE_MODEL: environment.RESPONSES_LIVE_MODEL,
    RESPONSES_LIVE_API_KEY: environment.RESPONSES_LIVE_API_KEY || undefined,
    RESPONSES_LIVE_ITERATIONS: environment.RESPONSES_LIVE_ITERATIONS,
    RESPONSES_LIVE_TIMEOUT_MS: environment.RESPONSES_LIVE_TIMEOUT_MS,
  })
  return {
    baseUrl: secureProviderUrl(parsed.RESPONSES_LIVE_BASE_URL),
    model: parsed.RESPONSES_LIVE_MODEL,
    apiKey: parsed.RESPONSES_LIVE_API_KEY ?? null,
    iterations: parsed.RESPONSES_LIVE_ITERATIONS,
    timeoutMs: parsed.RESPONSES_LIVE_TIMEOUT_MS,
  }
}
