import { describe, expect, it } from 'vitest'
import { summarizeToolActivity, type ToolActivityEvidence } from '../src/shared/tool-activity'

const activity = (
  callId: string,
  tool: string,
  status: ToolActivityEvidence['status'],
): ToolActivityEvidence => ({ callId, tool, status, summary: `${tool}:${callId}` })

describe('summarizeToolActivity', () => {
  it('marks failed attempts as recovered only when the same tool later succeeds', () => {
    const result = summarizeToolActivity(
      [
        activity('attempt-1', 'propose_file_changes', 'error'),
        activity('attempt-2', 'propose_file_changes', 'error'),
        activity('read', 'read_file', 'completed'),
        activity('attempt-3', 'propose_file_changes', 'completed'),
      ],
      'completed',
      ['src/App.tsx', 'src/App.tsx'],
    )

    expect(result).toMatchObject({
      outcome: 'recovered',
      recoveredCount: 2,
      unresolvedErrorCount: 0,
      completedCount: 2,
      appliedFileCount: 1,
    })
    expect(result.activities.map(({ displayStatus }) => displayStatus)).toEqual([
      'recovered',
      'recovered',
      'completed',
      'completed',
    ])
  })

  it('keeps a failure visible when a different tool succeeds later', () => {
    const result = summarizeToolActivity(
      [activity('command', 'run_command', 'error'), activity('inspect', 'read_file', 'completed')],
      'completed',
      [],
    )

    expect(result).toMatchObject({
      outcome: 'warning',
      recoveredCount: 0,
      unresolvedErrorCount: 1,
      completedCount: 1,
    })
    expect(result.activities[0]?.displayStatus).toBe('error')
  })

  it('keeps the terminal run failure prominent while preserving applied-file evidence', () => {
    const result = summarizeToolActivity(
      [
        activity('attempt-1', 'propose_file_changes', 'error'),
        activity('attempt-2', 'propose_file_changes', 'completed'),
      ],
      'error',
      ['src/new-file.ts'],
    )

    expect(result).toMatchObject({
      outcome: 'error',
      recoveredCount: 1,
      unresolvedErrorCount: 0,
      appliedFileCount: 1,
    })
  })

  it('does not treat a success before a later failure as recovery', () => {
    const result = summarizeToolActivity(
      [
        activity('success', 'read_file', 'completed'),
        activity('later-failure', 'read_file', 'error'),
      ],
      'completed',
      [],
    )

    expect(result).toMatchObject({
      outcome: 'warning',
      recoveredCount: 0,
      unresolvedErrorCount: 1,
    })
  })
})
