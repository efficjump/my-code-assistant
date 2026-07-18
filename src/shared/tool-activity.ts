export type ToolRunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'error'

export interface ToolActivityEvidence {
  callId: string
  tool: string
  summary: string
  status: 'running' | 'completed' | 'error'
}

export type ToolActivityDisplayStatus = ToolActivityEvidence['status'] | 'recovered'

export type ToolActivityOutcome =
  | 'running'
  | 'completed'
  | 'recovered'
  | 'warning'
  | 'cancelled'
  | 'interrupted'
  | 'error'

export interface ClassifiedToolActivity extends ToolActivityEvidence {
  displayStatus: ToolActivityDisplayStatus
}

export interface ToolActivitySummary {
  activities: ClassifiedToolActivity[]
  outcome: ToolActivityOutcome
  runningCount: number
  completedCount: number
  recoveredCount: number
  unresolvedErrorCount: number
  appliedFileCount: number
}

/**
 * The event contract does not expose retry identifiers. A failed call is therefore considered
 * recovered only when the ordered run evidence contains a later successful call to the same
 * registered tool. Failures without that evidence remain visible even when the response completes.
 */
export function summarizeToolActivity(
  activities: readonly ToolActivityEvidence[],
  runStatus: ToolRunStatus,
  changedPaths: readonly string[],
): ToolActivitySummary {
  const recoveredCallIds = new Set<string>()
  const successfulToolsAfter = new Set<string>()

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]
    if (activity.status === 'completed') {
      successfulToolsAfter.add(activity.tool)
    } else if (activity.status === 'error' && successfulToolsAfter.has(activity.tool)) {
      recoveredCallIds.add(activity.callId)
    }
  }

  const classified = activities.map((activity) => ({
    ...activity,
    displayStatus: recoveredCallIds.has(activity.callId) ? ('recovered' as const) : activity.status,
  }))
  const runningCount = classified.filter((activity) => activity.displayStatus === 'running').length
  const completedCount = classified.filter(
    (activity) => activity.displayStatus === 'completed',
  ).length
  const recoveredCount = classified.filter(
    (activity) => activity.displayStatus === 'recovered',
  ).length
  const unresolvedErrorCount = classified.filter(
    (activity) => activity.displayStatus === 'error',
  ).length

  let outcome: ToolActivityOutcome
  if (runStatus === 'starting' || runStatus === 'running' || runningCount > 0) {
    outcome = 'running'
  } else if (runStatus === 'error') {
    outcome = 'error'
  } else if (runStatus === 'interrupted') {
    outcome = 'interrupted'
  } else if (runStatus === 'cancelled') {
    outcome = 'cancelled'
  } else if (unresolvedErrorCount > 0) {
    outcome = 'warning'
  } else if (recoveredCount > 0) {
    outcome = 'recovered'
  } else {
    outcome = 'completed'
  }

  return {
    activities: classified,
    outcome,
    runningCount,
    completedCount,
    recoveredCount,
    unresolvedErrorCount,
    appliedFileCount: new Set(changedPaths).size,
  }
}
