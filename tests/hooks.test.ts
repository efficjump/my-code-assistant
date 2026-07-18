import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HookService,
  type HookServiceError,
  type HookServiceOptions,
} from '../src/main/services/hooks'
import { TrustStore } from '../src/main/services/trust'
import { WorkspaceService } from '../src/main/services/workspace'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const absolutePath = join(root, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function nativeHook(
  event: string,
  program: string,
  options: { matcher?: string; timeoutMs?: number } = {},
): unknown {
  return {
    hooks: {
      [event]: [
        {
          matcher: options.matcher ?? '',
          hooks: [
            {
              type: 'command',
              argv: [process.execPath, '-e', program],
              ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            },
          ],
        },
      ],
    },
  }
}

async function environment(
  trusted: boolean,
  options: HookServiceOptions = {},
): Promise<{
  root: string
  userData: string
  workspace: WorkspaceService
  trust: TrustStore
  hooks: HookService
}> {
  const root = await temporaryDirectory('code-assistant-hooks-workspace-')
  const userData = await temporaryDirectory('code-assistant-hooks-user-data-')
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(root, false)
  const trust = new TrustStore({ userDataPath: userData })
  if (trusted) await trust.setWorkspaceTrust(root, true)
  return {
    root,
    userData,
    workspace,
    trust,
    hooks: new HookService(workspace, trust, { userDataPath: userData, ...options }),
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('HookService', () => {
  it('does not discover or execute project hooks before Workspace Trust', async () => {
    const env = await environment(false)
    const marker = join(env.root, 'untrusted-hook-ran')
    await writeJson(
      env.root,
      '.assistant/hooks.json',
      nativeHook(
        'PreToolUse',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        { matcher: '^read_file$' },
      ),
    )

    expect(await env.hooks.list()).toEqual([])
    const result = await env.hooks.dispatch({
      event: 'PreToolUse',
      sessionId: 'untrusted-session',
      matcherValue: 'read_file',
      payload: { tool_name: 'read_file' },
    })

    expect(result).toMatchObject({ decision: 'continue', executions: [] })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalizes configured hook sources into canonical descriptors', async () => {
    const env = await environment(true, {
      sources: [
        { path: '.assistant/hooks.json', source: 'assistant' },
        { path: '.extensions-a/hooks.json', source: 'extension-a' },
        { path: '.extensions-b/settings.json', source: 'extension-b' },
      ],
    })
    await writeJson(
      env.root,
      '.assistant/hooks.json',
      nativeHook('SessionStart', "process.stdout.write('{}')", { matcher: 'startup|resume' }),
    )
    await writeJson(env.root, '.extensions-a/hooks.json', {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: "printf '{}'" }],
          },
        ],
      },
    })
    await writeJson(env.root, '.extensions-b/settings.json', {
      permissions: { deny: ['Write'] },
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: "printf '{}'", timeout: 3 }],
          },
        ],
      },
    })

    const catalog = await env.hooks.inspect()
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.hooks.map(({ source }) => source)).toEqual([
      'assistant',
      'extension-a',
      'extension-b',
    ])
    expect(catalog.hooks.every(({ revision }) => /^[a-f0-9]{64}$/.test(revision))).toBe(true)
    expect(catalog.hooks[0].handler).toMatchObject({ shell: false, command: null })
    expect(catalog.hooks[1].handler).toMatchObject({ shell: true, command: "printf '{}'" })
    expect(catalog.hooks[2].handler.timeoutMs).toBe(3_000)
    expect(isAbsolute(catalog.hooks[1].handler.argv[0])).toBe(true)
    expect(catalog.hooks.every(({ trusted }) => !trusted)).toBe(true)
  })

  it('requires exact revision trust, sends bounded JSON stdin, and invalidates changed hooks', async () => {
    const env = await environment(true)
    const secretName = 'CODE_ASSISTANT_HOOK_TEST_SECRET'
    const previousSecret = process.env[secretName]
    process.env[secretName] = 'must-not-cross-process-boundary'
    const program = `
      let source = ''
      process.stdin.on('data', chunk => { source += chunk })
      process.stdin.on('end', () => {
        const input = JSON.parse(source)
        process.stdout.write(JSON.stringify({
          additionalContext: [input.hook_event_name, input.tool_name, process.env.${secretName} ?? 'clean']
        }))
      })
    `
    await writeJson(
      env.root,
      '.assistant/hooks.json',
      nativeHook('PreToolUse', program, { matcher: '^read_file$' }),
    )

    try {
      const [descriptor] = await env.hooks.list()
      const beforeTrust = await env.hooks.dispatch({
        event: 'PreToolUse',
        sessionId: 'exact-trust',
        matcherValue: 'read_file',
        payload: { tool_name: 'read_file', tool_input: { path: 'src/main.ts' } },
      })
      expect(beforeTrust.executions).toEqual([])
      expect(beforeTrust.skippedUntrustedHookIds).toEqual([descriptor.id])

      await env.hooks.setTrusted({
        id: descriptor.id,
        revision: descriptor.revision,
        trusted: true,
      })
      const trusted = await env.hooks.dispatch({
        event: 'PreToolUse',
        sessionId: 'exact-trust',
        runId: 'root-run',
        matcherValue: 'read_file',
        payload: { tool_name: 'read_file', tool_input: { path: 'src/main.ts' } },
      })
      expect(trusted.decision).toBe('continue')
      expect(trusted.additionalContext).toEqual(['PreToolUse', 'read_file', 'clean'])
      expect(trusted.executions).toEqual([
        expect.objectContaining({ status: 'completed', ignoredPermissionElevation: false }),
      ])

      const trustPath = join(env.userData, 'hook-trust.json')
      const persisted = JSON.parse(await readFile(trustPath, 'utf8')) as { hooks: unknown }
      expect(persisted.hooks).toBeTruthy()
      if (process.platform !== 'win32') {
        expect((await stat(trustPath)).mode & 0o777).toBe(0o600)
        expect((await stat(env.userData)).mode & 0o777).toBe(0o700)
      }

      await writeJson(
        env.root,
        '.assistant/hooks.json',
        nativeHook('PreToolUse', `${program}\n// revision changed`, { matcher: '^read_file$' }),
      )
      const [changed] = await env.hooks.list()
      expect(changed.id).toBe(descriptor.id)
      expect(changed.revision).not.toBe(descriptor.revision)
      expect(changed.trusted).toBe(false)
      await expect(
        env.hooks.setTrusted({
          id: descriptor.id,
          revision: descriptor.revision,
          trusted: true,
        }),
      ).rejects.toMatchObject({ code: 'REVISION_MISMATCH' } satisfies Partial<HookServiceError>)
      const afterChange = await env.hooks.dispatch({
        event: 'PreToolUse',
        sessionId: 'changed-hook',
        matcherValue: 'read_file',
        payload: { tool_name: 'read_file' },
      })
      expect(afterChange.executions).toEqual([])
      expect(afterChange.skippedUntrustedHookIds).toEqual([descriptor.id])
    } finally {
      if (previousSecret === undefined) delete process.env[secretName]
      else process.env[secretName] = previousSecret
    }
  })

  it('treats exit code 2 and JSON deny as blocks while ignoring permission elevation', async () => {
    const env = await environment(true)
    const exitBlock = {
      type: 'command',
      argv: [
        process.execPath,
        '-e',
        "process.stderr.write('protected operation'); process.exit(2)",
      ],
    }
    const allow = {
      type: 'command',
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow',additionalContext:'reviewed only'}}))`,
      ],
    }
    const deny = {
      type: 'command',
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'repository policy denied it'}}))`,
      ],
    }
    await writeJson(env.root, '.assistant/hooks.json', {
      hooks: {
        PreToolUse: [{ matcher: '^run_command$', hooks: [exitBlock, allow, deny] }],
      },
    })
    const descriptors = await env.hooks.list()
    for (const descriptor of descriptors) {
      await env.hooks.setTrusted({
        id: descriptor.id,
        revision: descriptor.revision,
        trusted: true,
      })
    }

    const result = await env.hooks.dispatch({
      event: 'PreToolUse',
      sessionId: 'blocking-hooks',
      matcherValue: 'run_command',
      payload: { tool_name: 'run_command' },
    })

    expect(result.decision).toBe('block')
    expect(result.reason).toContain('protected operation')
    expect(result.reason).toContain('repository policy denied it')
    expect(result.additionalContext).toEqual(['reviewed only'])
    expect(result.executions).toHaveLength(3)
    expect(result.executions[1]).toMatchObject({
      status: 'completed',
      ignoredPermissionElevation: true,
    })
    expect(result.executions[2]).toMatchObject({ status: 'blocked' })
  })

  it('rejects unsafe matcher expressions without evaluating them', async () => {
    const env = await environment(true)
    await writeJson(env.root, '.assistant/hooks.json', {
      hooks: {
        PreToolUse: [
          {
            matcher: '^(a+)+$',
            hooks: [{ type: 'command', argv: [process.execPath, '-e', ''] }],
          },
        ],
      },
    })

    const catalog = await env.hooks.inspect()
    expect(catalog.hooks).toEqual([])
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ event: 'PreToolUse', message: expect.stringContaining('unsafe') }),
    ])
  })

  it('fails closed on timeout and propagates explicit cancellation', async () => {
    const timeoutEnvironment = await environment(true, {
      defaultTimeoutMs: 40,
      maximumTimeoutMs: 500,
      processRunnerOptions: { forceKillDelayMs: 10 },
    })
    await writeJson(
      timeoutEnvironment.root,
      '.assistant/hooks.json',
      nativeHook('Stop', 'setInterval(() => {}, 1_000)', { timeoutMs: 30 }),
    )
    const [timeoutHook] = await timeoutEnvironment.hooks.list()
    await timeoutEnvironment.hooks.setTrusted({
      id: timeoutHook.id,
      revision: timeoutHook.revision,
      trusted: true,
    })

    const timedOut = await timeoutEnvironment.hooks.dispatch({
      event: 'Stop',
      sessionId: 'timeout-hook',
    })
    expect(timedOut).toMatchObject({ decision: 'block' })
    expect(timedOut.executions).toEqual([
      expect.objectContaining({ status: 'error', timedOut: true }),
    ])

    const cancellationEnvironment = await environment(true, {
      defaultTimeoutMs: 1_000,
      maximumTimeoutMs: 2_000,
      processRunnerOptions: { forceKillDelayMs: 10 },
    })
    await writeJson(
      cancellationEnvironment.root,
      '.assistant/hooks.json',
      nativeHook('Stop', 'setInterval(() => {}, 1_000)', { timeoutMs: 1_000 }),
    )
    const [cancelHook] = await cancellationEnvironment.hooks.list()
    await cancellationEnvironment.hooks.setTrusted({
      id: cancelHook.id,
      revision: cancelHook.revision,
      trusted: true,
    })
    const controller = new AbortController()
    const pending = cancellationEnvironment.hooks.dispatch(
      { event: 'Stop', sessionId: 'cancel-hook' },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(new Error('cancelled by parent')), 30)

    await expect(pending).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    } satisfies Partial<HookServiceError>)
  })
})
