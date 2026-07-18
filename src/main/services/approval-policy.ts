import { createHash } from 'node:crypto'
import { relative, sep } from 'node:path'
import type {
  ApprovalRequest,
  WorkspaceApprovalPolicy,
  WorkspaceApprovalPolicyConfiguration,
} from '../../shared/contracts'
import { isPathContained } from './workspace'

export type ApprovalPolicyDecision =
  | {
      outcome: 'auto-approve'
      reasonCode: 'matched-rule'
      policyRevision: string
      ruleId: string
    }
  | {
      outcome: 'require-manual' | 'deny'
      reasonCode: string
      policyRevision: string
    }

export interface ApprovalPolicyEvaluationContext {
  workspacePath: string | null
  workspaceTrusted: boolean
  goalId: string | null
}

function policyConfiguration(
  policy: WorkspaceApprovalPolicy,
): WorkspaceApprovalPolicyConfiguration {
  return { fileChanges: policy.fileChanges, commands: policy.commands }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function workspaceApprovalPolicyRevision(policy: WorkspaceApprovalPolicy): string {
  return createHash('sha256')
    .update('workspace-approval-policy\0')
    .update(policy.workspacePath)
    .update('\0')
    .update(canonicalJson(policyConfiguration(policy)))
    .digest('hex')
}

function scopeMatches(scope: 'goals-only' | 'all-act-runs', goalId: string | null): boolean {
  return scope === 'all-act-runs' || goalId !== null
}

function relativePathMatchesPrefix(path: string, prefix: string): boolean {
  return prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)
}

function isNormalizedRelativeFilePath(path: string): boolean {
  if (
    path.length < 1 ||
    path === '.' ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    return false
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function boundedSum(values: readonly number[], maximum: number): boolean {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > maximum - value) return false
    total += value
  }
  return total <= maximum
}

function evaluateFileChanges(
  policy: WorkspaceApprovalPolicy,
  request: Extract<ApprovalRequest, { kind: 'file-change' }>,
  goalId: string | null,
  revision: string,
): ApprovalPolicyDecision {
  const filePolicy = policy.fileChanges
  if (filePolicy.mode === 'manual') {
    return { outcome: 'require-manual', reasonCode: 'file-policy-manual', policyRevision: revision }
  }
  if (!scopeMatches(filePolicy.scope, goalId)) {
    return {
      outcome: 'require-manual',
      reasonCode: 'file-scope-mismatch',
      policyRevision: revision,
    }
  }
  if (request.changes.some((change) => !isNormalizedRelativeFilePath(change.path))) {
    return { outcome: 'deny', reasonCode: 'file-boundary-invalid', policyRevision: revision }
  }
  if (request.changes.length < 1 || request.changes.length > filePolicy.maxFilesPerRequest) {
    return { outcome: 'require-manual', reasonCode: 'file-count-limit', policyRevision: revision }
  }
  if (
    !boundedSum(
      request.changes.flatMap((change) => [change.additions, change.deletions]),
      filePolicy.maxChangedLinesPerRequest,
    )
  ) {
    return { outcome: 'require-manual', reasonCode: 'file-line-limit', policyRevision: revision }
  }
  if (
    !boundedSum(
      request.changes.map((change) => Buffer.byteLength(change.diff, 'utf8')),
      filePolicy.maxChangedBytesPerRequest,
    )
  ) {
    return { outcome: 'require-manual', reasonCode: 'file-byte-limit', policyRevision: revision }
  }

  const matchingRuleIndex = filePolicy.rules.findIndex((rule) =>
    request.changes.every(
      (change) =>
        rule.operations.includes(change.kind) &&
        relativePathMatchesPrefix(change.path, rule.pathPrefix),
    ),
  )
  return matchingRuleIndex >= 0
    ? {
        outcome: 'auto-approve',
        reasonCode: 'matched-rule',
        policyRevision: revision,
        ruleId: `file:${matchingRuleIndex.toString()}`,
      }
    : {
        outcome: 'require-manual',
        reasonCode: 'file-rule-mismatch',
        policyRevision: revision,
      }
}

function portableRelativePath(root: string, target: string): string | null {
  if (!isPathContained(root, target)) return null
  const value = relative(root, target)
  if (!value) return '.'
  return value.split(sep).join('/')
}

function evaluateCommand(
  policy: WorkspaceApprovalPolicy,
  request: Extract<ApprovalRequest, { kind: 'command' }>,
  goalId: string | null,
  revision: string,
): ApprovalPolicyDecision {
  const commandPolicy = policy.commands
  if (commandPolicy.mode === 'manual') {
    return {
      outcome: 'require-manual',
      reasonCode: 'command-policy-manual',
      policyRevision: revision,
    }
  }
  if (!scopeMatches(commandPolicy.scope, goalId)) {
    return {
      outcome: 'require-manual',
      reasonCode: 'command-scope-mismatch',
      policyRevision: revision,
    }
  }
  const executable = request.argv[0]
  const relativeCwd = policy.workspacePath
    ? portableRelativePath(policy.workspacePath, request.cwd)
    : null
  if (
    !executable ||
    relativeCwd === null ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1
  ) {
    return {
      outcome: 'deny',
      reasonCode: 'command-boundary-invalid',
      policyRevision: revision,
    }
  }
  if (isPathContained(policy.workspacePath, executable)) {
    return {
      outcome: 'require-manual',
      reasonCode: 'workspace-executable-requires-manual',
      policyRevision: revision,
    }
  }

  const arguments_ = request.argv.slice(1)
  const matchingRuleIndex = commandPolicy.rules.findIndex((rule) => {
    if (rule.executable !== executable) return false
    if (request.timeoutMs > rule.maxTimeoutMs) return false
    if (request.network === 'host' && !rule.allowHostNetwork) return false
    if (!relativePathMatchesPrefix(relativeCwd, rule.workingDirectoryPrefix)) return false
    if (
      rule.argumentPrefix.some((argument, index) => arguments_[index] !== argument) ||
      arguments_.length < rule.argumentPrefix.length
    ) {
      return false
    }
    return rule.allowAdditionalArguments || arguments_.length === rule.argumentPrefix.length
  })
  return matchingRuleIndex >= 0
    ? {
        outcome: 'auto-approve',
        reasonCode: 'matched-rule',
        policyRevision: revision,
        ruleId: `command:${matchingRuleIndex.toString()}`,
      }
    : {
        outcome: 'require-manual',
        reasonCode: 'command-rule-mismatch',
        policyRevision: revision,
      }
}

export function evaluateApprovalPolicy(
  policy: WorkspaceApprovalPolicy,
  request: ApprovalRequest,
  context: ApprovalPolicyEvaluationContext,
): ApprovalPolicyDecision {
  const revision = workspaceApprovalPolicyRevision(policy)
  if (
    !context.workspacePath ||
    policy.workspacePath !== context.workspacePath ||
    !context.workspaceTrusted
  ) {
    return { outcome: 'deny', reasonCode: 'workspace-not-authorized', policyRevision: revision }
  }
  if (request.kind === 'file-change') {
    return evaluateFileChanges(policy, request, context.goalId, revision)
  }
  if (request.kind === 'command') {
    return evaluateCommand(policy, request, context.goalId, revision)
  }
  return {
    outcome: 'require-manual',
    reasonCode: 'unsupported-approval-kind',
    policyRevision: revision,
  }
}
