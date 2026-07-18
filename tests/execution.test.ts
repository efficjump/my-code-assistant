import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type StructuredProcessError,
  StructuredProcessRunner,
} from '../src/main/services/execution'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function workspaceProvider(path: string): { getWorkspace(): { path: string } } {
  return { getWorkspace: () => ({ path }) }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('StructuredProcessRunner', () => {
  it('resolves a bare executable to the canonical absolute PATH target before approval', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      environmentSource: {
        PATH: dirname(process.execPath),
        ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      },
    })

    const preview = await runner.preview({ argv: [basename(process.execPath), '--version'] })

    expect(preview.argv[0]).toBe(await realpath(process.execPath))
    expect(preview.argv[0]).toMatch(/^[/\\]|^[A-Za-z]:[\\/]/)
  })

  it('does not resolve executables through relative PATH entries', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      environmentSource: { PATH: '.' },
    })

    await expect(
      runner.preview({ argv: [basename(process.execPath), '--version'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' } satisfies Partial<StructuredProcessError>)
  })

  it('passes shell metacharacters as a literal argv entry', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const unexpectedFile = join(workspace, 'should-not-exist')
    const literal = `; touch ${unexpectedFile} && echo injected`
    const runner = new StructuredProcessRunner(workspaceProvider(workspace))

    const result = await runner.run({
      argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal],
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(literal)
    await expect(access(unexpectedFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('scrubs inherited credentials and uses an ephemeral home', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const temporaryRoot = await temporaryDirectory('code-assistant-execution-home-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      tempDirectory: temporaryRoot,
    })
    const previousSecret = process.env.CODE_ASSISTANT_TEST_SECRET
    const previousToken = process.env.API_TOKEN
    const previousSsh = process.env.SSH_AUTH_SOCK
    process.env.CODE_ASSISTANT_TEST_SECRET = 'must-not-cross-boundary'
    process.env.API_TOKEN = 'must-not-cross-boundary'
    process.env.SSH_AUTH_SOCK = '/private/agent.sock'

    try {
      const result = await runner.run({
        argv: [
          process.execPath,
          '-e',
          `process.stdout.write(JSON.stringify({
            secret: process.env.CODE_ASSISTANT_TEST_SECRET,
            token: process.env.API_TOKEN,
            ssh: process.env.SSH_AUTH_SOCK,
            home: process.env.HOME,
          }))`,
        ],
      })
      const childEnvironment = JSON.parse(result.stdout) as Record<string, string | undefined>
      expect(childEnvironment.secret).toBeUndefined()
      expect(childEnvironment.token).toBeUndefined()
      expect(childEnvironment.ssh).toBeUndefined()
      expect(childEnvironment.home).toContain(temporaryRoot)
      expect(childEnvironment.home).not.toBe(process.env.HOME)
      expect(result.isolation).toBe('structured-process')
      expect(result.network).toBe('host')
    } finally {
      if (previousSecret === undefined) delete process.env.CODE_ASSISTANT_TEST_SECRET
      else process.env.CODE_ASSISTANT_TEST_SECRET = previousSecret
      if (previousToken === undefined) delete process.env.API_TOKEN
      else process.env.API_TOKEN = previousToken
      if (previousSsh === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = previousSsh
    }
  })

  it('terminates a process tree when its timeout expires', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      defaultTimeoutMs: 50,
      forceKillDelayMs: 20,
    })

    const result = await runner.run({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
    })

    expect(result.timedOut).toBe(true)
    expect(result.cancelled).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode !== null || result.signal !== null).toBe(true)
  })

  it('force-terminates a descendant that ignores the graceful tree signal', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const marker = join(workspace, 'descendant-survived')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      defaultTimeoutMs: 50,
      forceKillDelayMs: 20,
    })
    const descendantProgram = `
      const fs = require('node:fs')
      process.on('SIGTERM', () => {})
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 250)
      setInterval(() => {}, 1_000)
    `
    const parentProgram = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: 'ignore' })
      setInterval(() => {}, 1_000)
    `

    const result = await runner.run({ argv: [process.execPath, '-e', parentProgram] })
    await new Promise((complete) => setTimeout(complete, 350))

    expect(result.timedOut).toBe(true)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors AbortSignal cancellation', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      forceKillDelayMs: 20,
    })
    const controller = new AbortController()
    const pending = runner.run(
      { argv: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'] },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 30)

    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode !== null || result.signal !== null).toBe(true)
  })

  it('bounds collected and streamed output while recording actual byte count', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      maxOutputBytes: 128,
    })
    const streamed: string[] = []

    const result = await runner.run(
      { argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(2_048))"] },
      { onOutput: ({ chunk }) => streamed.push(chunk) },
    )

    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(128)
    expect(Buffer.byteLength(streamed.join(''))).toBe(128)
    expect(result.totalOutputBytes).toBe(2_048)
    expect(result.outputTruncated).toBe(true)
  })

  it('writes bounded stdin once and closes the stream', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      maxInputBytes: 128,
    })
    const stdin = JSON.stringify({ event: 'PreToolUse', value: 'literal input' })

    const result = await runner.run(
      {
        argv: [
          process.execPath,
          '-e',
          "let value=''; process.stdin.on('data', c => value += c); process.stdin.on('end', () => process.stdout.write(value))",
        ],
      },
      { stdin },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(stdin)
  })

  it('rejects stdin above the configured byte boundary before spawning', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const marker = join(workspace, 'should-not-spawn')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace), {
      maxInputBytes: 8,
    })

    await expect(
      runner.run(
        {
          argv: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
          ],
        },
        { stdin: 'x'.repeat(9) },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STDIN' } satisfies Partial<StructuredProcessError>)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a cwd that resolves outside the workspace', async () => {
    const workspace = await temporaryDirectory('code-assistant-execution-')
    const outside = await temporaryDirectory('code-assistant-execution-outside-')
    const runner = new StructuredProcessRunner(workspaceProvider(workspace))

    await expect(
      runner.run({ argv: [process.execPath, '-e', ''], cwd: outside }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' } satisfies Partial<StructuredProcessError>)
  })
})
