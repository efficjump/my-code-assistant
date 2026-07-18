import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ResponsesApiDriver } from '../../src/main/drivers/responses-api'
import type {
  CanonicalDriverEvent,
  CanonicalToolDefinition,
} from '../../src/main/runtime/assistant-driver'
import { loadLiveResponsesProviderConfig } from './support/live-provider-config'

const liveConfig = loadLiveResponsesProviderConfig()

if (liveConfig) {
  describe.sequential('live Responses API driver', () => {
    const driver = new ResponsesApiDriver({
      requestTimeoutMs: liveConfig.timeoutMs,
      modelListTimeoutMs: liveConfig.timeoutMs,
      maxOutputTokens: 2_048,
    })
    const profile = {
      id: 'live-responses-eval',
      name: 'Live Responses evaluation',
      baseUrl: liveConfig.baseUrl,
      apiKey: liveConfig.apiKey,
      generation: 1,
    }

    it(
      'discovers the configured model and completes tool loops through the final report',
      async () => {
        const models = await driver.listModels(profile, {
          signal: AbortSignal.timeout(liveConfig.timeoutMs),
        })
        expect(models.some((model) => model.id === liveConfig.model)).toBe(true)

        for (let iteration = 0; iteration < liveConfig.iterations; iteration += 1) {
          const nonce = randomUUID()
          const tool: CanonicalToolDefinition = {
            name: 'record_probe',
            description: 'Record the exact live-evaluation nonce and requested phase.',
            strict: true,
            inputSchema: {
              type: 'object',
              properties: {
                nonce: { type: 'string', const: nonce },
                phase: { type: 'integer', enum: [1, 2] },
              },
              required: ['nonce', 'phase'],
              additionalProperties: false,
            },
          }
          const argumentsSchema = z
            .object({ nonce: z.literal(nonce), phase: z.union([z.literal(1), z.literal(2)]) })
            .strict()
          let session = driver.appendUserMessage(
            driver.createSession(),
            `Run the two-phase tool probe for nonce ${nonce}.`,
          )
          const callIds = new Set<string>()

          for (const phase of [1, 2] as const) {
            const events: CanonicalDriverEvent[] = []
            const turn = await driver.runTurn(
              {
                runId: `live-responses-${iteration.toString()}-${phase.toString()}`,
                profile,
                model: liveConfig.model,
                instructions: `Call record_probe exactly once with nonce ${nonce} and phase ${phase.toString()}. Return the call through the provider tool channel.`,
                tools: [tool],
                toolChoice: { type: 'function', name: tool.name },
                session,
                signal: AbortSignal.timeout(liveConfig.timeoutMs),
                maxOutputTokens: 2_048,
              },
              (event) => events.push(event),
            )
            expect(turn.finalText).toBe('')
            expect(turn.toolCalls).toHaveLength(1)
            const call = turn.toolCalls[0]
            expect(call?.name).toBe(tool.name)
            expect(argumentsSchema.parse(JSON.parse(call?.argumentsJson ?? '{}'))).toEqual({
              nonce,
              phase,
            })
            expect(events.some((event) => event.type === 'text-delta')).toBe(false)
            expect(callIds.has(call?.callId ?? '')).toBe(false)
            callIds.add(call?.callId ?? '')
            session = driver.appendToolResults(turn.session, [
              {
                callId: call?.callId ?? '',
                output: JSON.stringify({ ok: true, nonce, phase }),
              },
            ])
          }

          const finalReportSession = driver.createSession([
            {
              type: 'message',
              role: 'user',
              content: `Report the verified two-phase probe result for nonce ${nonce}.`,
            },
          ])
          const finalTurn = await driver.runTurn({
            runId: `live-responses-${iteration.toString()}-final`,
            profile,
            model: liveConfig.model,
            instructions: `Both probe phases for nonce ${nonce} completed successfully. Do not call tools. Return a concise final report that includes the nonce.`,
            tools: [],
            protocolGuardTools: [tool],
            toolChoice: 'none',
            session: finalReportSession,
            signal: AbortSignal.timeout(liveConfig.timeoutMs),
            maxOutputTokens: 2_048,
          })
          expect(finalTurn.toolCalls).toEqual([])
          expect(finalTurn.finalText.trim().length).toBeGreaterThan(0)
          expect(finalTurn.finalText).toContain(nonce)
        }
      },
      liveConfig.timeoutMs * liveConfig.iterations * 4,
    )
  })
} else {
  describe.skip('live Responses API driver', () => {
    it('requires explicit live-provider opt-in', () => undefined)
  })
}
