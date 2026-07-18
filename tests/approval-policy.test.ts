import { describe, expect, it } from 'vitest'
import {
  evaluateApprovalPolicy,
  workspaceApprovalPolicyRevision,
} from '../src/main/services/approval-policy'
import type {
  ApprovalRequest,
  FileChangePreview,
  WorkspaceApprovalPolicy,
} from '../src/shared/contracts'

const WORKSPACE = '/workspace/project'
const EXECUTABLE = '/opt/homebrew/bin/pnpm'

type FileChangeRequest = Extract<ApprovalRequest, { kind: 'file-change' }>
type CommandRequest = Extract<ApprovalRequest, { kind: 'command' }>
type AutomaticFilePolicy = Extract<WorkspaceApprovalPolicy['fileChanges'], { mode: 'auto' }>
type AutomaticCommandPolicy = Extract<WorkspaceApprovalPolicy['commands'], { mode: 'auto' }>

const trustedContext = { workspacePath: WORKSPACE, workspaceTrusted: true, goalId: null }

function manualPolicy(): WorkspaceApprovalPolicy {
  return {
    workspacePath: WORKSPACE,
    fileChanges: { mode: 'manual' },
    commands: { mode: 'manual' },
  }
}

function automaticFilePolicy(
  overrides: Partial<AutomaticFilePolicy> = {},
): WorkspaceApprovalPolicy {
  return {
    workspacePath: WORKSPACE,
    fileChanges: {
      mode: 'auto',
      scope: 'all-act-runs',
      rules: [{ pathPrefix: 'src', operations: ['create', 'update'] }],
      maxFilesPerRequest: 10,
      maxChangedLinesPerRequest: 1_000,
      maxChangedBytesPerRequest: 1_000_000,
      ...overrides,
    },
    commands: { mode: 'manual' },
  }
}

function automaticCommandPolicy(
  overrides: Partial<AutomaticCommandPolicy> = {},
): WorkspaceApprovalPolicy {
  return {
    workspacePath: WORKSPACE,
    fileChanges: { mode: 'manual' },
    commands: {
      mode: 'auto',
      scope: 'all-act-runs',
      rules: [
        {
          executable: EXECUTABLE,
          argumentPrefix: ['test'],
          allowAdditionalArguments: false,
          workingDirectoryPrefix: '.',
          maxTimeoutMs: 60_000,
          allowHostNetwork: true,
        },
      ],
      ...overrides,
    },
  }
}

function change(overrides: Partial<FileChangePreview> = {}): FileChangePreview {
  return {
    path: 'src/index.ts',
    kind: 'update',
    diff: '+updated\n',
    additions: 1,
    deletions: 0,
    beforeHash: 'a'.repeat(64),
    afterHash: 'b'.repeat(64),
    ...overrides,
  }
}

function fileRequest(changes: FileChangePreview[] = [change()]): FileChangeRequest {
  return {
    kind: 'file-change',
    approvalId: 'approval-file',
    actionHash: 'c'.repeat(64),
    summary: 'Update files',
    changes,
    expiresAt: Date.now() + 60_000,
  }
}

function commandRequest(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    kind: 'command',
    approvalId: 'approval-command',
    actionHash: 'd'.repeat(64),
    summary: 'Run command',
    argv: [EXECUTABLE, 'test'],
    cwd: WORKSPACE,
    timeoutMs: 60_000,
    isolation: 'structured-process',
    network: 'host',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

describe('approval policy evaluator', () => {
  it('requires manual approval by default for file changes and commands', () => {
    const policy = manualPolicy()

    expect(evaluateApprovalPolicy(policy, fileRequest(), trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'file-policy-manual',
    })
    expect(evaluateApprovalPolicy(policy, commandRequest(), trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'command-policy-manual',
    })
  })

  it('denies unless the trusted context identifies the exact policy workspace', () => {
    const policy = automaticFilePolicy()
    const unauthorizedContexts = [
      { workspacePath: null, workspaceTrusted: true, goalId: null },
      { workspacePath: `${WORKSPACE}/`, workspaceTrusted: true, goalId: null },
      { workspacePath: `${WORKSPACE}-copy`, workspaceTrusted: true, goalId: null },
      { workspacePath: WORKSPACE, workspaceTrusted: false, goalId: null },
    ]

    for (const context of unauthorizedContexts) {
      expect(evaluateApprovalPolicy(policy, fileRequest(), context)).toMatchObject({
        outcome: 'deny',
        reasonCode: 'workspace-not-authorized',
      })
    }
  })

  it('applies goals-only scope to goal runs but not interactive act runs', () => {
    const goalContext = { ...trustedContext, goalId: 'goal-1' }
    const filePolicy = automaticFilePolicy({ scope: 'goals-only' })
    const commandPolicy = automaticCommandPolicy({ scope: 'goals-only' })

    expect(evaluateApprovalPolicy(filePolicy, fileRequest(), trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'file-scope-mismatch',
    })
    expect(evaluateApprovalPolicy(filePolicy, fileRequest(), goalContext).outcome).toBe(
      'auto-approve',
    )
    expect(evaluateApprovalPolicy(commandPolicy, commandRequest(), trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'command-scope-mismatch',
    })
    expect(evaluateApprovalPolicy(commandPolicy, commandRequest(), goalContext).outcome).toBe(
      'auto-approve',
    )
  })

  it('permits all-act-runs policies for interactive act runs', () => {
    expect(
      evaluateApprovalPolicy(automaticFilePolicy(), fileRequest(), trustedContext).outcome,
    ).toBe('auto-approve')
    expect(
      evaluateApprovalPolicy(automaticCommandPolicy(), commandRequest(), trustedContext).outcome,
    ).toBe('auto-approve')
  })

  it('matches file prefixes on path-segment boundaries', () => {
    const policy = automaticFilePolicy()

    for (const path of ['src', 'src/index.ts', 'src/nested/index.ts']) {
      expect(
        evaluateApprovalPolicy(policy, fileRequest([change({ path })]), trustedContext).outcome,
      ).toBe('auto-approve')
    }
    for (const path of ['src2/index.ts', 'source/index.ts']) {
      expect(
        evaluateApprovalPolicy(policy, fileRequest([change({ path })]), trustedContext),
      ).toMatchObject({
        outcome: 'require-manual',
        reasonCode: 'file-rule-mismatch',
      })
    }
  })

  it('denies non-normalized file paths before a root-wide rule can match', () => {
    const policy = automaticFilePolicy({
      rules: [{ pathPrefix: '.', operations: ['create', 'update', 'delete'] }],
    })

    for (const path of [
      '../outside.ts',
      'src/../outside.ts',
      '/outside.ts',
      'src//index.ts',
      'src\\index.ts',
      'src/secret\0.ts',
    ]) {
      expect(
        evaluateApprovalPolicy(policy, fileRequest([change({ path })]), trustedContext),
      ).toMatchObject({
        outcome: 'deny',
        reasonCode: 'file-boundary-invalid',
      })
    }
    expect(
      evaluateApprovalPolicy(policy, fileRequest([change({ path: 'README.md' })]), trustedContext)
        .outcome,
    ).toBe('auto-approve')
  })

  it('requires every change in a request to match one complete rule', () => {
    const policy = automaticFilePolicy({
      rules: [
        { pathPrefix: 'src', operations: ['update'] },
        { pathPrefix: 'tests', operations: ['create'] },
      ],
    })
    const request = fileRequest([
      change({ path: 'src/index.ts', kind: 'update' }),
      change({ path: 'tests/index.test.ts', kind: 'create' }),
    ])

    expect(evaluateApprovalPolicy(policy, request, trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'file-rule-mismatch',
    })
  })

  it('enforces aggregate file count, changed-line, and UTF-8 diff-byte limits', () => {
    const countPolicy = automaticFilePolicy({ maxFilesPerRequest: 2 })
    const twoChanges = [change(), change({ path: 'src/second.ts' })]
    expect(
      evaluateApprovalPolicy(countPolicy, fileRequest(twoChanges), trustedContext).outcome,
    ).toBe('auto-approve')
    expect(
      evaluateApprovalPolicy(
        countPolicy,
        fileRequest([...twoChanges, change({ path: 'src/third.ts' })]),
        trustedContext,
      ),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'file-count-limit' })
    expect(evaluateApprovalPolicy(countPolicy, fileRequest([]), trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'file-count-limit',
    })

    const linePolicy = automaticFilePolicy({ maxChangedLinesPerRequest: 3 })
    expect(
      evaluateApprovalPolicy(
        linePolicy,
        fileRequest([change({ additions: 2, deletions: 1 })]),
        trustedContext,
      ).outcome,
    ).toBe('auto-approve')
    expect(
      evaluateApprovalPolicy(
        linePolicy,
        fileRequest([change({ additions: 3, deletions: 1 })]),
        trustedContext,
      ),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'file-line-limit' })
    expect(
      evaluateApprovalPolicy(
        linePolicy,
        fileRequest([change({ additions: -1, deletions: 0 })]),
        trustedContext,
      ),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'file-line-limit' })

    const bytePolicy = automaticFilePolicy({ maxChangedBytesPerRequest: 2 })
    expect(
      evaluateApprovalPolicy(
        bytePolicy,
        fileRequest([change({ diff: 'é', additions: 0 })]),
        trustedContext,
      ).outcome,
    ).toBe('auto-approve')
    expect(
      evaluateApprovalPolicy(
        bytePolicy,
        fileRequest([change({ diff: '€', additions: 0 })]),
        trustedContext,
      ),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'file-byte-limit' })
  })

  it('evaluates create, update, and delete operations exactly', () => {
    const allOperations = automaticFilePolicy({
      rules: [{ pathPrefix: 'src', operations: ['create', 'update', 'delete'] }],
    })

    for (const kind of ['create', 'update', 'delete'] as const) {
      expect(
        evaluateApprovalPolicy(allOperations, fileRequest([change({ kind })]), trustedContext)
          .outcome,
      ).toBe('auto-approve')
    }

    const createsOnly = automaticFilePolicy({
      rules: [{ pathPrefix: 'src', operations: ['create'] }],
    })
    expect(
      evaluateApprovalPolicy(
        createsOnly,
        fileRequest([change({ kind: 'update' })]),
        trustedContext,
      ),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'file-rule-mismatch' })
  })

  it('requires an exact canonical executable path and never auto-approves workspace executables', () => {
    const policy = automaticCommandPolicy()

    expect(evaluateApprovalPolicy(policy, commandRequest(), trustedContext).outcome).toBe(
      'auto-approve',
    )
    for (const executable of [`${EXECUTABLE}2`, 'pnpm']) {
      expect(
        evaluateApprovalPolicy(
          policy,
          commandRequest({ argv: [executable, 'test'] }),
          trustedContext,
        ),
      ).toMatchObject({ outcome: 'require-manual', reasonCode: 'command-rule-mismatch' })
    }

    const workspaceExecutable = `${WORKSPACE}/bin/task-runner`
    const workspaceExecutablePolicy = automaticCommandPolicy({
      rules: [
        {
          executable: workspaceExecutable,
          argumentPrefix: [],
          allowAdditionalArguments: false,
          workingDirectoryPrefix: '.',
          maxTimeoutMs: 60_000,
          allowHostNetwork: true,
        },
      ],
    })
    expect(
      evaluateApprovalPolicy(
        workspaceExecutablePolicy,
        commandRequest({ argv: [workspaceExecutable] }),
        trustedContext,
      ),
    ).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'workspace-executable-requires-manual',
    })
  })

  it('matches command argument prefixes as exact argv tokens and controls additional arguments', () => {
    const strictRule: AutomaticCommandPolicy['rules'][number] = {
      executable: EXECUTABLE,
      argumentPrefix: ['test', '--unit'],
      allowAdditionalArguments: false,
      workingDirectoryPrefix: '.',
      maxTimeoutMs: 60_000,
      allowHostNetwork: true,
    }
    const strictPolicy = automaticCommandPolicy({ rules: [strictRule] })

    expect(
      evaluateApprovalPolicy(
        strictPolicy,
        commandRequest({ argv: [EXECUTABLE, 'test', '--unit'] }),
        trustedContext,
      ).outcome,
    ).toBe('auto-approve')
    for (const argv of [
      [EXECUTABLE, 'test'],
      [EXECUTABLE, '--unit', 'test'],
      [EXECUTABLE, 'test --unit'],
      [EXECUTABLE, 'test', '--unit', '--watch'],
    ]) {
      expect(
        evaluateApprovalPolicy(strictPolicy, commandRequest({ argv }), trustedContext).outcome,
      ).toBe('require-manual')
    }

    const extensiblePolicy = automaticCommandPolicy({
      rules: [{ ...strictRule, allowAdditionalArguments: true }],
    })
    expect(
      evaluateApprovalPolicy(
        extensiblePolicy,
        commandRequest({ argv: [EXECUTABLE, 'test', '--unit', '--watch'] }),
        trustedContext,
      ).outcome,
    ).toBe('auto-approve')
  })

  it('matches command working directories on path-segment boundaries', () => {
    const policy = automaticCommandPolicy({
      rules: [
        {
          executable: EXECUTABLE,
          argumentPrefix: ['test'],
          allowAdditionalArguments: false,
          workingDirectoryPrefix: 'packages/app',
          maxTimeoutMs: 60_000,
          allowHostNetwork: true,
        },
      ],
    })

    for (const cwd of [`${WORKSPACE}/packages/app`, `${WORKSPACE}/packages/app/unit`]) {
      expect(evaluateApprovalPolicy(policy, commandRequest({ cwd }), trustedContext).outcome).toBe(
        'auto-approve',
      )
    }
    expect(
      evaluateApprovalPolicy(
        policy,
        commandRequest({ cwd: `${WORKSPACE}/packages/application` }),
        trustedContext,
      ),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'command-rule-mismatch' })
    expect(
      evaluateApprovalPolicy(policy, commandRequest({ cwd: '/workspace/outside' }), trustedContext),
    ).toMatchObject({ outcome: 'deny', reasonCode: 'command-boundary-invalid' })
  })

  it('enforces command timeout and host-network constraints', () => {
    const timeoutRule: AutomaticCommandPolicy['rules'][number] = {
      executable: EXECUTABLE,
      argumentPrefix: ['test'],
      allowAdditionalArguments: false,
      workingDirectoryPrefix: '.',
      maxTimeoutMs: 1_000,
      allowHostNetwork: true,
    }
    const policy = automaticCommandPolicy({ rules: [timeoutRule] })

    expect(
      evaluateApprovalPolicy(policy, commandRequest({ timeoutMs: 1_000 }), trustedContext).outcome,
    ).toBe('auto-approve')
    expect(
      evaluateApprovalPolicy(policy, commandRequest({ timeoutMs: 1_001 }), trustedContext),
    ).toMatchObject({ outcome: 'require-manual', reasonCode: 'command-rule-mismatch' })
    expect(
      evaluateApprovalPolicy(policy, commandRequest({ timeoutMs: 0 }), trustedContext),
    ).toMatchObject({ outcome: 'deny', reasonCode: 'command-boundary-invalid' })

    const noHostNetwork = automaticCommandPolicy({
      rules: [{ ...timeoutRule, allowHostNetwork: false }],
    })
    expect(evaluateApprovalPolicy(noHostNetwork, commandRequest(), trustedContext)).toMatchObject({
      outcome: 'require-manual',
      reasonCode: 'command-rule-mismatch',
    })
  })

  it('always keeps MCP server and MCP tool requests on manual approval', () => {
    const policy = automaticFilePolicy()
    const requests: ApprovalRequest[] = [
      {
        kind: 'mcp-server',
        approvalId: 'approval-mcp-server',
        actionHash: 'e'.repeat(64),
        summary: 'Start MCP server',
        configurationRevision: 'f'.repeat(64),
        configPath: `${WORKSPACE}/.mcp.json`,
        servers: [],
        isolation: 'structured-process',
        network: 'host',
        expiresAt: Date.now() + 60_000,
      },
      {
        kind: 'mcp-tool',
        approvalId: 'approval-mcp-tool',
        actionHash: '0'.repeat(64),
        summary: 'Invoke MCP tool',
        serverName: 'service',
        toolName: 'lookup',
        argumentsJson: '{}',
        capabilities: ['network'],
        network: 'host',
        expiresAt: Date.now() + 60_000,
      },
    ]

    for (const request of requests) {
      expect(evaluateApprovalPolicy(policy, request, trustedContext)).toMatchObject({
        outcome: 'require-manual',
        reasonCode: 'unsupported-approval-kind',
      })
    }
  })

  it('produces a deterministic revision independent of object key insertion order', () => {
    const policy = automaticFilePolicy({
      rules: [{ pathPrefix: 'src', operations: ['update', 'create'] }],
    })
    const reordered: WorkspaceApprovalPolicy = {
      commands: { mode: 'manual' },
      fileChanges: {
        maxChangedBytesPerRequest: 1_000_000,
        maxChangedLinesPerRequest: 1_000,
        maxFilesPerRequest: 10,
        rules: [{ operations: ['update', 'create'], pathPrefix: 'src' }],
        scope: 'all-act-runs',
        mode: 'auto',
      },
      workspacePath: WORKSPACE,
    }

    const revision = workspaceApprovalPolicyRevision(policy)
    expect(revision).toMatch(/^[a-f0-9]{64}$/)
    expect(workspaceApprovalPolicyRevision(policy)).toBe(revision)
    expect(workspaceApprovalPolicyRevision(reordered)).toBe(revision)
    expect(
      workspaceApprovalPolicyRevision(
        automaticFilePolicy({
          rules: [{ pathPrefix: 'src', operations: ['update', 'create'] }],
          maxFilesPerRequest: 11,
        }),
      ),
    ).not.toBe(revision)
    expect(evaluateApprovalPolicy(policy, fileRequest(), trustedContext).policyRevision).toBe(
      revision,
    )
  })
})
