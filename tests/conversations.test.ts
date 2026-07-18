import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConversationRepository,
  type ConversationRepositoryError,
} from '../src/main/services/conversations'
import { hostMessages } from '../src/main/services/host-messages'

const temporaryDirectories: string[] = []

function temporaryRepository(now?: () => number): {
  repository: ConversationRepository
  directory: string
  databasePath: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'code-assistant-conversations-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'history.sqlite3')
  return {
    repository: new ConversationRepository({ databasePath, now }),
    directory,
    databasePath,
  }
}

function downgradeGoalTablesToVersionThree(databasePath: string): void {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE goals_v3 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('active', 'paused', 'blocked', 'completed', 'cleared')
        ),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
        progress_summary TEXT NOT NULL DEFAULT '',
        blocked_summary TEXT,
        completion_summary TEXT,
        token_budget INTEGER CHECK (
          token_budget IS NULL OR (token_budget >= 1 AND token_budget <= 9007199254740991)
        ),
        used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
          used_tokens >= 0 AND used_tokens <= 9007199254740991
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        cleared_at INTEGER,
        CHECK (status != 'blocked' OR blocked_summary IS NOT NULL),
        CHECK (status != 'completed' OR completion_summary IS NOT NULL),
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
        CHECK ((status = 'cleared') = (cleared_at IS NOT NULL))
      ) STRICT;

      INSERT INTO goals_v3
        (id, conversation_id, objective, status, revision, plan_revision, progress_summary,
         blocked_summary, completion_summary, token_budget, used_tokens, created_at, updated_at,
         completed_at, cleared_at)
      SELECT id, conversation_id, objective, status, revision, plan_revision, progress_summary,
             blocked_summary, completion_summary, token_budget, used_tokens, created_at, updated_at,
             completed_at, cleared_at
      FROM goals;

      CREATE TABLE goal_plan_revisions_v3 (
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        explanation TEXT NOT NULL DEFAULT '',
        items_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (goal_id, revision)
      ) STRICT;

      INSERT INTO goal_plan_revisions_v3
        (goal_id, revision, goal_revision, run_id, explanation, items_json, created_at)
      SELECT goal_id, revision, goal_revision, run_id, explanation, items_json, created_at
      FROM goal_plan_revisions;

      CREATE TABLE goal_checkpoints_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
        plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        subagent_run_id TEXT REFERENCES subagent_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (
          status IN ('active', 'paused', 'blocked', 'completed', 'cleared')
        ),
        summary TEXT NOT NULL,
        used_tokens INTEGER NOT NULL CHECK (
          used_tokens >= 0 AND used_tokens <= 9007199254740991
        ),
        created_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO goal_checkpoints_v3
        (id, goal_id, goal_revision, plan_revision, run_id, subagent_run_id, status, summary,
         used_tokens, created_at)
      SELECT id, goal_id, goal_revision, plan_revision, run_id, subagent_run_id, status, summary,
             used_tokens, created_at
      FROM goal_checkpoints;

      DROP TRIGGER goal_checkpoints_immutable;
      DROP TRIGGER goal_plan_revisions_immutable;
      DROP TABLE goal_checkpoints;
      DROP TABLE goal_plan_revisions;
      DROP TABLE goals;

      ALTER TABLE goals_v3 RENAME TO goals;
      ALTER TABLE goal_plan_revisions_v3 RENAME TO goal_plan_revisions;
      ALTER TABLE goal_checkpoints_v3 RENAME TO goal_checkpoints;

      CREATE UNIQUE INDEX goals_one_open_per_conversation
        ON goals(conversation_id)
        WHERE status IN ('active', 'paused', 'blocked');
      CREATE INDEX goals_conversation_updated
        ON goals(conversation_id, updated_at DESC);
      CREATE INDEX goal_plans_created
        ON goal_plan_revisions(goal_id, created_at DESC);
      CREATE INDEX goal_checkpoints_created
        ON goal_checkpoints(goal_id, created_at DESC, id DESC);

      CREATE TRIGGER goal_plan_revisions_immutable
      BEFORE UPDATE ON goal_plan_revisions
      BEGIN
        SELECT RAISE(ABORT, 'goal plan revisions are immutable');
      END;

      CREATE TRIGGER goal_checkpoints_immutable
      BEFORE UPDATE ON goal_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'goal checkpoints are immutable');
      END;

      PRAGMA user_version = 3;
      COMMIT;
    `)
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the fixture construction error.
    }
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
    database.close()
  }
}

function downgradeRunTableToVersionFour(databasePath: string): void {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE runs_v4 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        provider_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('running', 'completed', 'cancelled', 'error', 'interrupted')
        ),
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      ) STRICT;

      INSERT INTO runs_v4
        (id, conversation_id, provider_id, model_id, status, error, started_at, finished_at)
      SELECT id, conversation_id, provider_id, model_id, status, error, started_at, finished_at
      FROM runs;

      DROP TABLE runs;
      ALTER TABLE runs_v4 RENAME TO runs;
      CREATE INDEX runs_conversation_started
        ON runs(conversation_id, started_at);

      PRAGMA user_version = 4;
      COMMIT;
    `)
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the fixture construction error.
    }
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
    database.close()
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ConversationRepository persistence', () => {
  it('restores unresolved mutation refresh requirements without storing file contents', () => {
    const { repository } = temporaryRepository()
    const currentSha256 = 'a'.repeat(64)
    repository.ensureConversation({ id: 'durable-mutation-refresh' })
    repository.appendAuditEvent({
      conversationId: 'durable-mutation-refresh',
      type: 'tool.failed',
      summary: 'A file mutation conflicted.',
      metadata: {
        failureCode: 'HASH_CONFLICT',
        failureDetails: {
          path: 'src/existing.ts',
          currentSha256,
          sourceContent: 'must not be stored',
        },
      },
    })
    repository.appendAuditEvent({
      conversationId: 'durable-mutation-refresh',
      type: 'mutation.refresh_required',
      summary: 'An exact read is required.',
      metadata: {
        failureCode: 'PATCH_CONFLICT',
        path: 'src/patch.ts',
        currentSha256: 'b'.repeat(64),
      },
    })
    repository.appendAuditEvent({
      conversationId: 'durable-mutation-refresh',
      type: 'tool.failed',
      summary: 'An update target was missing.',
      metadata: {
        failureCode: 'HASH_CONFLICT',
        failureDetails: {
          path: 'src/missing.ts',
          currentSha256: null,
        },
      },
    })

    expect(repository.pendingMutationRefreshes('durable-mutation-refresh')).toEqual([
      {
        path: 'src/existing.ts',
        failureCode: 'HASH_CONFLICT',
        currentSha256,
      },
      {
        path: 'src/patch.ts',
        failureCode: 'PATCH_CONFLICT',
        currentSha256: 'b'.repeat(64),
      },
    ])
    expect(
      repository
        .getConversation('durable-mutation-refresh')
        ?.auditEvents.find((event) => event.type === 'tool.failed')?.metadata,
    ).toMatchObject({
      failureDetails: { currentSha256, sourceContent: '[OMITTED]' },
    })

    repository.appendAuditEvent({
      conversationId: 'durable-mutation-refresh',
      type: 'mutation.refresh_completed',
      summary: 'The file was read again.',
      metadata: { path: 'src/existing.ts' },
    })
    expect(repository.pendingMutationRefreshes('durable-mutation-refresh')).toEqual([
      {
        path: 'src/patch.ts',
        failureCode: 'PATCH_CONFLICT',
        currentSha256: 'b'.repeat(64),
      },
    ])
    repository.close()
  })

  it('restores only complete recent turns inside the requested character budget', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({ id: 'bounded-history' })
    for (const [id, role, content] of [
      ['old-user', 'user', '1234567890'],
      ['old-assistant', 'assistant', 'abcdefghij'],
      ['new-user', 'user', '1234'],
      ['new-assistant', 'assistant', 'abcd'],
    ] as const) {
      repository.appendMessage({
        id,
        conversationId: 'bounded-history',
        role,
        displayContent: content,
        status: 'completed',
      })
    }

    expect(repository.modelHistory('bounded-history', { maxCharacters: 8 })).toEqual([
      { role: 'user', content: '1234' },
      { role: 'assistant', content: 'abcd' },
    ])
    expect(repository.modelHistory('bounded-history', { maxCharacters: 5 })).toEqual([])
    repository.close()
  })

  it.runIf(process.platform !== 'win32')(
    'uses private POSIX permissions for the database directory and SQLite files',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'code-assistant-conversations-'))
      temporaryDirectories.push(directory)
      const storageDirectory = join(directory, 'history')
      mkdirSync(storageDirectory, { mode: 0o777 })
      chmodSync(storageDirectory, 0o777)
      const databasePath = join(storageDirectory, 'history.sqlite3')
      const repository = new ConversationRepository({ databasePath })

      expect(statSync(storageDirectory).mode & 0o777).toBe(0o700)
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }

      repository.close()
    },
  )

  it('quarantines a corrupt SQLite database and recreates usable storage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-assistant-conversations-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'history.sqlite3')
    const corruptBytes = Buffer.from('this is deliberately not a SQLite database')
    writeFileSync(databasePath, corruptBytes)

    const repository = new ConversationRepository({ databasePath })
    const quarantineFiles = readdirSync(directory).filter((name) =>
      name.startsWith('history.sqlite3.corrupt-'),
    )

    expect(repository.recoveryNotice).toMatchObject({
      type: 'conversation-database-quarantined',
      backupPath: expect.stringContaining('history.sqlite3.corrupt-'),
    })
    expect(quarantineFiles).toHaveLength(1)
    expect(readFileSync(join(directory, quarantineFiles[0]))).toEqual(corruptBytes)
    expect(repository.ensureConversation({ id: 'after-recovery' })).toMatchObject({
      id: 'after-recovery',
      status: 'active',
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    expect(reopened.recoveryNotice).toBeNull()
    expect(reopened.getConversation('after-recovery')).toMatchObject({ id: 'after-recovery' })
    reopened.close()
  })

  it('persists display/model messages, run state, tool summaries, and redacted audit events', () => {
    let clock = 1_000
    const { repository, databasePath } = temporaryRepository(() => ++clock)
    const conversation = repository.ensureConversation({
      id: 'conversation-1',
      summary: 'Plan the durable store',
      providerId: 'provider-1',
      modelId: 'model-1',
      workspacePath: '/workspace/one',
    })
    expect(conversation).toMatchObject({
      id: 'conversation-1',
      status: 'active',
      messageCount: 0,
    })

    repository.appendMessage({
      id: 'user-1',
      conversationId: conversation.id,
      role: 'user',
      displayContent: '/plan durable history',
      modelContent: 'Create a durable history plan.',
      contextPaths: ['src/main/index.ts'],
    })
    const run = repository.startRun({
      id: 'run-1',
      conversationId: conversation.id,
      providerId: 'provider-1',
      modelId: 'model-1',
    })
    repository.appendMessage({
      id: 'assistant-1',
      conversationId: conversation.id,
      role: 'assistant',
      displayContent: '',
      runId: run.id,
      status: 'running',
      toolActivities: [
        {
          callId: 'call-1',
          tool: 'search_text',
          summary: 'Workspace search completed',
          status: 'completed',
        },
      ],
    })
    repository.updateMessage('assistant-1', {
      displayContent: 'Use a versioned SQLite schema.',
      modelContent: 'Use a versioned SQLite schema.',
    })
    repository.finishRun(run.id, { status: 'completed' })
    repository.appendAuditEvent({
      conversationId: conversation.id,
      type: 'approval.recorded',
      summary: 'authorization=Bearer abcdefghijklmnop',
      metadata: {
        apiKey: ['sk', 'this-must-not-survive'].join('-'),
        sourceContent: 'raw source must not survive',
        nested: { token: 'plain-secret', decision: 'approved' },
      },
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    const detail = reopened.getConversation(conversation.id)
    expect(detail).toMatchObject({
      summary: 'Plan the durable store',
      providerId: 'provider-1',
      modelId: 'model-1',
      workspacePath: '/workspace/one',
      messageCount: 2,
    })
    expect(detail?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        displayContent: '/plan durable history',
        modelContent: 'Create a durable history plan.',
        contextPaths: ['src/main/index.ts'],
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        displayContent: 'Use a versioned SQLite schema.',
        status: 'completed',
        toolActivities: [
          expect.objectContaining({
            tool: 'search_text',
            summary: 'Workspace search completed',
            status: 'completed',
            startedAt: null,
            completedAt: null,
          }),
        ],
      }),
    ])
    expect(detail?.runs).toEqual([
      expect.objectContaining({ id: 'run-1', status: 'completed', error: null }),
    ])
    expect(repositoryClosedError(repository)).toBe('CLOSED')
    expect(detail?.auditEvents.find((event) => event.type === 'approval.recorded')).toMatchObject({
      summary: 'authorization=[REDACTED] [REDACTED]',
      metadata: {
        apiKey: '[REDACTED]',
        sourceContent: '[OMITTED]',
        nested: { token: '[REDACTED]', decision: 'approved' },
      },
    })
    expect(reopened.modelHistory(conversation.id)).toEqual([
      { role: 'user', content: 'Create a durable history plan.' },
      { role: 'assistant', content: 'Use a versioned SQLite schema.' },
    ])
    reopened.close()

    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 })
    expect(inspection.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    inspection.close()
  })

  it('updates metadata without clearing omitted fields and supports archive filtering', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({
      id: 'conversation-1',
      summary: 'Original',
      providerId: 'provider',
      modelId: 'model',
      workspacePath: '/workspace',
    })
    repository.ensureConversation({ id: 'conversation-1', summary: 'Updated' })

    expect(repository.getConversation('conversation-1')).toMatchObject({
      summary: 'Updated',
      providerId: 'provider',
      modelId: 'model',
      workspacePath: '/workspace',
    })
    expect(repository.archive('conversation-1')).toMatchObject({
      status: 'archived',
      archivedAt: expect.any(Number),
    })
    expect(repository.listConversations({ archived: false })).toEqual([])
    expect(repository.listConversations({ archived: true })).toHaveLength(1)
    expect(repository.archive('conversation-1', false)).toMatchObject({
      status: 'active',
      archivedAt: null,
    })
    repository.close()
  })

  it('migrates a version 2 store without losing existing conversations', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({
      id: 'before-v3',
      summary: 'Preserve this thread',
      providerGeneration: 7,
      workspacePath: '/workspace',
    })
    repository.close()

    const versionTwo = new DatabaseSync(databasePath)
    versionTwo.exec(`
      DROP TRIGGER goal_checkpoints_immutable;
      DROP TRIGGER goal_plan_revisions_immutable;
      DROP TABLE goal_checkpoints;
      DROP TABLE subagent_runs;
      DROP TABLE goal_plan_revisions;
      DROP TABLE goals;
      PRAGMA user_version = 2;
    `)
    versionTwo.close()

    const migrated = new ConversationRepository({ databasePath })
    expect(migrated.getConversation('before-v3')).toMatchObject({
      summary: 'Preserve this thread',
      providerGeneration: 7,
      workspacePath: '/workspace',
    })
    expect(migrated.listGoals('before-v3')).toEqual([])
    migrated.close()

    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 })
    inspection.close()
  })

  it('migrates version 3 goals without losing plans, checkpoints, or source references', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({
      id: 'origin',
      summary: 'Goal origin',
      workspacePath: '/workspace',
    })
    const goal = repository.createGoal({
      id: 'goal',
      conversationId: 'origin',
      objective: 'Preserve every durable goal record',
      tokenBudget: 10_000,
    })
    const run = repository.startRun({
      id: 'run',
      conversationId: 'origin',
      goalId: goal.id,
    })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: run.id,
      explanation: 'Migration fixture plan',
      items: [{ step: 'Migrate safely', status: 'in_progress' }],
    })
    const subagent = repository.startSubagentRun({
      id: 'subagent',
      conversationId: 'origin',
      goalId: goal.id,
      originRunId: run.id,
      name: 'migration-audit',
      task: 'Verify migrated goal history.',
    })
    const checkpoint = repository.appendGoalCheckpoint({
      goalId: goal.id,
      expectedGoalRevision: plan.goalRevision,
      subagentRunId: subagent.id,
      summary: 'Ready to migrate.',
      usedTokens: 250,
    })
    const beforeMigration = repository.getGoal(goal.id)
    repository.close()

    downgradeGoalTablesToVersionThree(databasePath)
    const versionThree = new DatabaseSync(databasePath, { readOnly: true })
    expect(versionThree.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
    expect(
      versionThree
        .prepare(
          "SELECT COUNT(*) AS count FROM pragma_table_info('goals') WHERE name = 'workspace_path'",
        )
        .get(),
    ).toMatchObject({ count: 0 })
    versionThree.close()

    const migrated = new ConversationRepository({ databasePath })
    expect(migrated.getGoal(goal.id)).toEqual(beforeMigration)
    expect(migrated.getCurrentGoalPlan(goal.id)).toEqual(plan)
    expect(migrated.listGoalCheckpoints(goal.id)).toEqual([checkpoint])
    const parallel = migrated.createGoal({
      id: 'parallel-goal',
      conversationId: 'origin',
      objective: 'Run independently in the same workspace',
    })
    expect(
      migrated.listGoals({ workspacePath: '/workspace', statuses: ['active'] }).map(({ id }) => id),
    ).toEqual(expect.arrayContaining([goal.id, parallel.id]))

    expect(migrated.delete('origin')).toBe(true)
    expect(migrated.getGoal(goal.id)).toMatchObject({
      originConversationId: null,
      workspacePath: '/workspace',
    })
    expect(migrated.getCurrentGoalPlan(goal.id)).toMatchObject({ runId: null })
    expect(migrated.listGoalCheckpoints(goal.id)).toEqual([
      expect.objectContaining({ subagentRunId: null }),
    ])
    migrated.close()

    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 })
    expect(inspection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      inspection
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'goals_one_open_per_conversation'",
        )
        .get(),
    ).toMatchObject({ count: 0 })
    inspection.close()
  })

  it('migrates version 4 runs with safe snapshots without losing dependent history', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      conversationId: 'conversation',
      objective: 'Preserve run-dependent goal history',
    })
    const run = repository.startRun({
      id: 'legacy-run',
      conversationId: 'conversation',
      goalId: goal.id,
      providerId: 'provider',
      modelId: 'model',
    })
    repository.appendMessage({
      id: 'message',
      conversationId: 'conversation',
      role: 'assistant',
      displayContent: 'A legacy run is still active.',
      runId: run.id,
      status: 'running',
    })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: run.id,
      items: [{ step: 'Preserve the legacy run reference', status: 'in_progress' }],
    })
    repository.close()

    downgradeRunTableToVersionFour(databasePath)
    const versionFour = new DatabaseSync(databasePath, { readOnly: true })
    expect(versionFour.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
    expect(
      versionFour
        .prepare("SELECT COUNT(*) AS count FROM pragma_table_info('runs') WHERE name = 'intent'")
        .get(),
    ).toMatchObject({ count: 0 })
    versionFour.close()

    const migrated = new ConversationRepository({ databasePath })
    expect(migrated.getConversation('conversation')?.runs).toEqual([
      expect.objectContaining({
        id: run.id,
        goalId: null,
        providerId: 'provider',
        modelId: 'model',
        intent: 'act',
        trigger: {
          providerId: 'builtin:legacy',
          type: 'legacy-run',
          dedupeKey: run.id,
        },
        policyId: 'builtin:interactive',
        attempt: 1,
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        outcomeSummary: null,
        status: 'running',
      }),
    ])
    expect(migrated.getConversation('conversation')?.messages[0]).toMatchObject({ runId: run.id })
    expect(migrated.getCurrentGoalPlan(goal.id)).toEqual(plan)
    migrated.close()

    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 })
    expect(inspection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      inspection
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'runs_goal_started'",
        )
        .get(),
    ).toMatchObject({ count: 1 })
    inspection.close()
  })

  it('round-trips bounded run snapshots and validates goal workspace ownership', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    repository.ensureConversation({ id: 'other-conversation', workspacePath: '/other-workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      workspacePath: '/workspace',
      objective: 'Persist a bounded run snapshot',
    })
    const otherGoal = repository.createGoal({
      id: 'other-goal',
      workspacePath: '/other-workspace',
      objective: 'Stay isolated from another workspace',
    })

    expect(() =>
      repository.startRun({
        id: 'workspace-mismatch',
        conversationId: 'conversation',
        goalId: otherGoal.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() =>
      repository.startRun({
        id: 'unknown-goal',
        conversationId: 'conversation',
        goalId: 'missing',
      }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() =>
      repository.startRun({
        id: 'invalid-intent',
        conversationId: 'conversation',
        intent: 'unknown',
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() =>
      repository.startRun({
        id: 'invalid-attempt',
        conversationId: 'conversation',
        attempt: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    const started = repository.startRun({
      id: 'snapshot-run',
      conversationId: 'conversation',
      goalId: goal.id,
      providerId: 'provider',
      modelId: 'model',
      intent: 'plan',
      trigger: {
        providerId: 'scheduler',
        type: 'manual-wake',
        dedupeKey: 'wake-3',
      },
      policyId: 'policy:read-only',
      attempt: 3,
    })
    expect(started).toMatchObject({
      goalId: goal.id,
      intent: 'plan',
      trigger: { providerId: 'scheduler', type: 'manual-wake', dedupeKey: 'wake-3' },
      policyId: 'policy:read-only',
      attempt: 3,
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      outcomeSummary: null,
      status: 'running',
    })
    const usage = { inputTokens: 120, outputTokens: 45, reasoningTokens: 12, totalTokens: 165 }
    const completed = repository.finishRun(started.id, {
      status: 'completed',
      usage,
      outcomeSummary: 'The bounded planning run completed with verified evidence.',
    })
    expect(completed).toMatchObject({
      status: 'completed',
      usage,
      outcomeSummary: 'The bounded planning run completed with verified evidence.',
    })
    expect(repository.finishRun(started.id, { status: 'completed' })).toEqual(completed)
    expect(() =>
      repository.finishRun(started.id, {
        status: 'completed',
        usage: { ...usage, totalTokens: usage.totalTokens + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
    expect(() =>
      repository.finishRun('missing-run', {
        status: 'completed',
        usage: { ...usage, inputTokens: -1 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    const detail = repository.getConversation('conversation')
    expect(detail?.auditEvents.find(({ type }) => type === 'run.started')).toMatchObject({
      metadata: {
        goalId: goal.id,
        providerId: 'provider',
        modelId: 'model',
        intent: 'plan',
        trigger: { providerId: 'scheduler', type: 'manual-wake', dedupeKey: 'wake-3' },
        policyId: 'policy:read-only',
        attempt: 3,
      },
    })
    expect(detail?.auditEvents.find(({ type }) => type === 'run.completed')).toMatchObject({
      metadata: {
        error: null,
        usage,
        outcomeSummary: 'The bounded planning run completed with verified evidence.',
      },
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    expect(reopened.getConversation('conversation')?.runs).toEqual([completed])
    reopened.close()
  })
})

describe('ConversationRepository branching and recovery', () => {
  it('atomically stores a host interruption summary and replays only complete marked summaries', () => {
    const { repository } = temporaryRepository()
    const initialize = (conversationId: string, runId: string) =>
      repository.initializeRun({
        conversation: { id: conversationId, status: 'active', workspacePath: '/workspace' },
        run: { id: runId, conversationId, intent: 'act' },
        userMessage: {
          id: `${runId}-user`,
          conversationId,
          role: 'user',
          displayContent: 'Apply the requested change.',
          modelContent: 'Apply the requested change.',
          runId,
          status: 'running',
        },
        assistantMessage: {
          id: `${runId}-assistant`,
          conversationId,
          role: 'assistant',
          displayContent: '',
          modelContent: '',
          runId,
          status: 'running',
          toolActivities: [],
        },
      })

    initialize('host-summary-conversation', 'host-summary-run')
    repository.finishInterruptedWithHostSummary('host-summary-run', {
      conversationId: 'host-summary-conversation',
      assistantMessageId: 'host-summary-run-assistant',
      hostSummary: 'Confirmed host result: the file change remains applied.',
      error: 'The final response was interrupted.',
      toolActivities: [],
      auditType: 'run.applied_effect_interrupted',
      auditSummary: 'The host persisted an interruption summary.',
      auditMetadata: { effects: ['workspace-change'] },
    })

    expect(repository.getConversation('host-summary-conversation')).toMatchObject({
      messages: [
        expect.objectContaining({ role: 'user', status: 'interrupted' }),
        expect.objectContaining({
          role: 'assistant',
          status: 'interrupted',
          modelContent: 'Confirmed host result: the file change remains applied.',
        }),
      ],
      runs: [expect.objectContaining({ status: 'interrupted' })],
      auditEvents: expect.arrayContaining([
        expect.objectContaining({ type: 'run.applied_effect_interrupted' }),
      ]),
    })
    expect(repository.modelHistory('host-summary-conversation')).toEqual([
      { role: 'user', content: 'Apply the requested change.' },
      { role: 'assistant', content: 'Confirmed host result: the file change remains applied.' },
    ])

    initialize('incomplete-summary-conversation', 'incomplete-summary-run')
    repository.appendAuditEvent({
      conversationId: 'incomplete-summary-conversation',
      runId: 'incomplete-summary-run',
      type: 'run.applied_effect_interrupted',
      summary: 'A marker without a committed host summary must not be replayed.',
    })
    repository.finishRun('incomplete-summary-run', {
      status: 'interrupted',
      error: 'Interrupted before the host summary was stored.',
    })
    expect(repository.modelHistory('incomplete-summary-conversation')).toEqual([])
  })

  it('rolls back the host summary update when atomic interruption finalization fails', () => {
    const { repository } = temporaryRepository()
    repository.initializeRun({
      conversation: { id: 'rollback-conversation', status: 'active' },
      run: { id: 'rollback-run', conversationId: 'rollback-conversation', intent: 'act' },
      userMessage: {
        id: 'rollback-user',
        conversationId: 'rollback-conversation',
        role: 'user',
        displayContent: 'Apply a change.',
        runId: 'rollback-run',
        status: 'running',
      },
      assistantMessage: {
        id: 'rollback-assistant',
        conversationId: 'rollback-conversation',
        role: 'assistant',
        displayContent: '',
        runId: 'rollback-run',
        status: 'running',
      },
    })
    repository.finishRun('rollback-run', { status: 'error', error: 'Original failure.' })

    expect(() =>
      repository.finishInterruptedWithHostSummary('rollback-run', {
        conversationId: 'rollback-conversation',
        assistantMessageId: 'rollback-assistant',
        hostSummary: 'This content must be rolled back.',
        error: 'Interrupted.',
        toolActivities: [],
        auditType: 'run.applied_effect_interrupted',
        auditSummary: 'This audit must also be rolled back.',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
    expect(repository.getConversation('rollback-conversation')).toMatchObject({
      messages: [
        expect.objectContaining({ role: 'user', status: 'error' }),
        expect.objectContaining({ role: 'assistant', status: 'error', modelContent: '' }),
      ],
      runs: [expect.objectContaining({ status: 'error', error: 'Original failure.' })],
    })
    expect(
      repository
        .getConversation('rollback-conversation')
        ?.auditEvents.some((event) => event.type === 'run.applied_effect_interrupted'),
    ).toBe(false)
  })

  it('forks through a selected message with fresh ids and no copied run journal', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({
      id: 'source',
      summary: 'Source conversation',
      providerId: 'provider',
      modelId: 'model',
      workspacePath: '/workspace',
    })
    repository.appendMessage({
      id: 'message-1',
      conversationId: 'source',
      role: 'user',
      displayContent: 'Question one',
    })
    repository.appendMessage({
      id: 'message-2',
      conversationId: 'source',
      role: 'assistant',
      displayContent: 'Answer one',
      status: 'completed',
    })
    repository.appendMessage({
      id: 'message-3',
      conversationId: 'source',
      role: 'user',
      displayContent: 'Question two',
    })

    const fork = repository.fork('source', {
      id: 'branch',
      summary: 'Alternative branch',
      throughMessageId: 'message-2',
    })

    expect(fork).toMatchObject({
      id: 'branch',
      summary: 'Alternative branch',
      status: 'active',
      providerId: 'provider',
      modelId: 'model',
      workspacePath: '/workspace',
    })
    expect(fork.messages.map((message) => message.displayContent)).toEqual([
      'Question one',
      'Answer one',
    ])
    expect(fork.messages.every((message) => message.conversationId === 'branch')).toBe(true)
    expect(fork.messages.every((message) => !message.runId)).toBe(true)
    expect(fork.messages.map((message) => message.id)).not.toContain('message-1')
    expect(fork.runs).toEqual([])
    expect(fork.auditEvents).toEqual([
      expect.objectContaining({
        type: 'conversation.forked',
        metadata: { sourceConversationId: 'source', throughMessageId: 'message-2' },
      }),
    ])
    repository.close()
  })

  it('recovers runs and streaming messages left by a prior process as interrupted', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      workspacePath: '/workspace',
      objective: 'Recover the interrupted bounded run',
    })
    repository.startRun({
      id: 'running-run',
      conversationId: 'conversation',
      goalId: goal.id,
      intent: 'answer',
      trigger: { providerId: 'scheduler', type: 'retry', dedupeKey: 'retry-2' },
      policyId: 'policy:read-only',
      attempt: 2,
    })
    repository.recordRunUsage('running-run', {
      inputTokens: 11,
      outputTokens: 4,
      reasoningTokens: 1,
      totalTokens: 15,
    })
    repository.appendMessage({
      id: 'running-assistant',
      conversationId: 'conversation',
      role: 'assistant',
      displayContent: 'Partial output',
      runId: 'running-run',
      status: 'running',
      toolActivities: [
        {
          callId: 'read-call',
          tool: 'read_file',
          summary: 'Read durable source evidence',
          status: 'completed',
        },
        {
          callId: 'list-call',
          tool: 'list_files',
          summary: 'Directory listing was in progress',
          status: 'running',
        },
      ],
    })
    repository.appendMessage({
      id: 'starting-assistant',
      conversationId: 'conversation',
      role: 'assistant',
      displayContent: '',
      status: 'starting',
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    const recoveryReason = hostMessages('ko').recovery.interruptedRunReason
    expect(reopened.recoverInterruptedRuns(recoveryReason)).toEqual({
      runIds: ['running-run'],
      messageIds: expect.arrayContaining(['running-assistant', 'starting-assistant']),
    })
    const recovered = reopened.getConversation('conversation')
    expect(recovered?.runs[0]).toMatchObject({
      goalId: goal.id,
      intent: 'answer',
      trigger: { providerId: 'scheduler', type: 'retry', dedupeKey: 'retry-2' },
      policyId: 'policy:read-only',
      attempt: 2,
      usage: { inputTokens: 11, outputTokens: 4, reasoningTokens: 1, totalTokens: 15 },
      outcomeSummary: null,
      status: 'interrupted',
      error: recoveryReason,
      finishedAt: expect.any(Number),
    })
    expect(recovered?.messages.map(({ status }) => status)).toEqual(['interrupted', 'interrupted'])
    const recoveredGoal = reopened.getGoal(goal.id)
    expect(recoveredGoal).toMatchObject({
      status: 'active',
      usedTokens: 15,
      revision: 2,
      planRevision: 0,
      progressSummary: expect.stringContaining('Host recovery checkpoint'),
    })
    const checkpoints = reopened.listGoalCheckpoints(goal.id)
    expect(checkpoints).toEqual([
      expect.objectContaining({
        goalRevision: 2,
        planRevision: 0,
        runId: 'running-run',
        status: 'active',
        usedTokens: 15,
      }),
    ])
    expect(checkpoints[0]?.summary).toContain('Tools: 2 recorded (completed=1, error=0, running=1)')
    expect(checkpoints[0]?.summary).toContain(
      'Usage: total=15, input=11, output=4, reasoning=1 tokens.',
    )
    expect(checkpoints[0]?.summary).toContain('No completion was inferred')
    expect(reopened.recoverInterruptedRuns()).toEqual({ runIds: [], messageIds: [] })
    expect(recovered?.auditEvents.some((event) => event.type === 'run.interrupted')).toBe(true)
    reopened.close()
  })

  it('includes applied file paths and redacts interruption secrets in a recovery checkpoint', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      workspacePath: '/workspace',
      objective: 'Preserve applied paths across an application restart',
    })
    repository.startRun({ id: 'run', conversationId: 'conversation', goalId: goal.id })
    repository.recordRunUsage('run', {
      inputTokens: 20,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 25,
    })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: 'run',
      items: [{ step: 'Verify the recovered file changes', status: 'in_progress' }],
    })
    repository.appendAuditEvent({
      conversationId: 'conversation',
      runId: 'run',
      type: 'files.changed',
      summary: 'Approved file changes applied.',
      metadata: { paths: ['src/App.ts', 'docs/recovery.md'], undoAvailable: true },
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    const rawSecret = 'Bearer abcdefghijklmnop'
    reopened.recoverInterruptedRuns(`Restarted after authorization=${rawSecret}`)
    const checkpoint = reopened.listGoalCheckpoints(goal.id)[0]
    expect(checkpoint).toMatchObject({
      runId: 'run',
      goalRevision: 3,
      planRevision: plan.revision,
      usedTokens: 25,
      status: 'active',
    })
    expect(reopened.getGoal(goal.id)).toMatchObject({
      revision: 3,
      planRevision: plan.revision,
      usedTokens: 25,
    })
    expect(checkpoint?.summary).toContain('"src/App.ts"')
    expect(checkpoint?.summary).toContain('"docs/recovery.md"')
    expect(checkpoint?.summary).toContain('authorization=[REDACTED]')
    expect(checkpoint?.summary).not.toContain('abcdefghijklmnop')
    expect(checkpoint?.summary.length).toBeLessThanOrEqual(16_000)
    const checkpointAudit = reopened
      .getConversation('conversation')
      ?.auditEvents.find(
        (event) =>
          event.type === 'goal.checkpoint.created' &&
          event.metadata &&
          typeof event.metadata === 'object' &&
          !Array.isArray(event.metadata) &&
          event.metadata.hostOwned === true,
      )
    expect(checkpointAudit).toMatchObject({
      metadata: {
        recovery: 'interrupted-run',
        changedPaths: ['src/App.ts', 'docs/recovery.md'],
      },
    })
    reopened.close()
  })

  it('does not duplicate an existing checkpoint for an interrupted Goal run', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      workspacePath: '/workspace',
      objective: 'Keep the model-authored checkpoint authoritative',
    })
    repository.startRun({ id: 'run', conversationId: 'conversation', goalId: goal.id })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: 'run',
      items: [{ step: 'Continue after restart', status: 'in_progress' }],
    })
    const original = repository.appendGoalCheckpoint({
      goalId: goal.id,
      expectedGoalRevision: plan.goalRevision,
      runId: 'run',
      summary: 'Progress was already checkpointed before the process exited.',
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    reopened.recoverInterruptedRuns('Application restarted.')
    expect(reopened.listGoalCheckpoints(goal.id)).toEqual([original])
    expect(reopened.getGoal(goal.id)).toMatchObject({
      revision: original.goalRevision,
      planRevision: plan.revision,
      progressSummary: original.summary,
    })
    expect(
      reopened
        .getConversation('conversation')
        ?.auditEvents.filter((event) => event.type === 'goal.checkpoint.created'),
    ).toHaveLength(1)
    reopened.close()
  })

  it('leaves terminal Goal runs and running non-Goal runs without recovery checkpoints', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      workspacePath: '/workspace',
      objective: 'Do not checkpoint terminal or unrelated runs',
    })
    repository.startRun({
      id: 'terminal-goal-run',
      conversationId: 'conversation',
      goalId: goal.id,
    })
    repository.finishRun('terminal-goal-run', {
      status: 'error',
      error: 'The run was already terminal.',
    })
    repository.startRun({ id: 'running-non-goal', conversationId: 'conversation' })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    expect(reopened.recoverInterruptedRuns('Application restarted.')).toEqual({
      runIds: ['running-non-goal'],
      messageIds: [],
    })
    expect(reopened.listGoalCheckpoints(goal.id)).toEqual([])
    expect(reopened.getGoal(goal.id)).toMatchObject({ revision: 1, progressSummary: '' })
    expect(reopened.getConversation('conversation')?.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'terminal-goal-run', status: 'error' }),
        expect.objectContaining({ id: 'running-non-goal', status: 'interrupted' }),
      ]),
    )
    reopened.close()
  })

  it('keeps the host recovery checkpoint idempotent across repository reopens', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      workspacePath: '/workspace',
      objective: 'Recover exactly once across repeated starts',
    })
    repository.startRun({ id: 'run', conversationId: 'conversation', goalId: goal.id })
    repository.close()

    const firstReopen = new ConversationRepository({ databasePath })
    expect(firstReopen.recoverInterruptedRuns('First restart.')).toEqual({
      runIds: ['run'],
      messageIds: [],
    })
    const firstCheckpoint = firstReopen.listGoalCheckpoints(goal.id)[0]
    expect(firstCheckpoint).toBeDefined()
    expect(firstReopen.getGoal(goal.id)).toMatchObject({ revision: 2, planRevision: 0 })
    firstReopen.close()

    const secondReopen = new ConversationRepository({ databasePath })
    expect(secondReopen.recoverInterruptedRuns('Second restart.')).toEqual({
      runIds: [],
      messageIds: [],
    })
    expect(secondReopen.listGoalCheckpoints(goal.id)).toEqual([firstCheckpoint])
    expect(secondReopen.getGoal(goal.id)).toMatchObject({ revision: 2, planRevision: 0 })
    secondReopen.close()
  })
})

describe('ConversationRepository durable goals', () => {
  it('creates conversation-independent goals and filters them by workspace and status', () => {
    const { repository } = temporaryRepository()
    const first = repository.createGoal({
      id: 'first',
      workspacePath: '/workspace/a',
      objective: 'Operate independently from a conversation',
    })
    const second = repository.createGoal({
      id: 'second',
      workspacePath: '/workspace/b',
      objective: 'Remain isolated in another workspace',
      status: 'paused',
    })

    expect(first).toMatchObject({
      originConversationId: null,
      conversationId: null,
      workspacePath: '/workspace/a',
    })
    expect(repository.listGoals({ workspacePath: '/workspace/a' })).toEqual([first])
    expect(repository.listGoals({ workspacePath: '/workspace/b', statuses: ['paused'] })).toEqual([
      second,
    ])
    expect(repository.listGoals({ workspacePath: '/workspace/b', statuses: ['active'] })).toEqual(
      [],
    )
    expect(() =>
      repository.createGoal({ id: 'unbound', objective: 'Missing a workspace binding' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    repository.ensureConversation({ id: 'origin', workspacePath: '/workspace/a' })
    expect(() =>
      repository.createGoal({
        id: 'mismatch',
        originConversationId: 'origin',
        workspacePath: '/workspace/b',
        objective: 'Do not cross workspace ownership.',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    repository.close()
  })

  it('supports multiple workspace-owned goals and revision-bound lifecycle updates', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })

    const created = repository.createGoal({
      id: 'goal-1',
      conversationId: 'conversation',
      objective: 'Implement durable goal support',
      tokenBudget: 50_000,
    })
    expect(created).toMatchObject({
      id: 'goal-1',
      conversationId: 'conversation',
      originConversationId: 'conversation',
      workspacePath: '/workspace',
      status: 'active',
      revision: 1,
      planRevision: 0,
      progressSummary: '',
      blockedSummary: null,
      completionSummary: null,
      tokenBudget: 50_000,
      usedTokens: 0,
    })
    const secondOpen = repository.createGoal({
      id: 'goal-conflict',
      conversationId: 'conversation',
      objective: 'A second open goal',
    })
    expect(
      repository
        .listGoals({ workspacePath: '/workspace', statuses: ['active'] })
        .map(({ id }) => id),
    ).toEqual(expect.arrayContaining([created.id, secondOpen.id]))

    const paused = repository.updateGoal(created.id, {
      expectedRevision: created.revision,
      status: 'paused',
      progressSummary: 'Waiting at a safe boundary.',
      usedTokens: 1_200,
    })
    expect(paused).toMatchObject({
      status: 'paused',
      revision: 2,
      usedTokens: 1_200,
    })
    expect(() =>
      repository.updateGoal(created.id, {
        expectedRevision: 1,
        status: 'active',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    expect(() =>
      repository.updateGoal(created.id, {
        expectedRevision: paused.revision,
        status: 'blocked',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    const blocked = repository.updateGoal(created.id, {
      expectedRevision: paused.revision,
      status: 'blocked',
      blockedSummary: 'A user decision is required.',
    })
    expect(blocked).toMatchObject({
      status: 'blocked',
      revision: 3,
      blockedSummary: 'A user decision is required.',
    })
    const completed = repository.updateGoal(created.id, {
      expectedRevision: blocked.revision,
      status: 'completed',
      completionSummary: 'Implementation and verification completed.',
      usedTokens: 2_400,
    })
    expect(completed).toMatchObject({
      status: 'completed',
      revision: 4,
      blockedSummary: null,
      completionSummary: 'Implementation and verification completed.',
      completedAt: expect.any(Number),
    })
    expect(repository.getOpenGoal('conversation')).toEqual(secondOpen)
    expect(() =>
      repository.updateGoal(created.id, {
        expectedRevision: completed.revision,
        status: 'active',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))

    const replacement = repository.createGoal({
      id: 'goal-2',
      conversationId: 'conversation',
      objective: 'Follow-up objective',
    })
    expect(repository.listGoals('conversation').map(({ id }) => id)).toEqual(
      expect.arrayContaining([replacement.id, secondOpen.id, completed.id]),
    )
    repository.archive('conversation')
    expect(repository.getGoal(replacement.id)).toMatchObject({ status: 'active', revision: 1 })
    expect(repository.getGoal(secondOpen.id)).toMatchObject({ status: 'active', revision: 1 })
    repository.archive('conversation', false)
    expect(repository.getGoal(replacement.id)).toMatchObject({ status: 'active', revision: 1 })
    repository.close()
  })

  it('stores complete immutable plan snapshots with strict progress validation', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation' })
    const goal = repository.createGoal({
      id: 'goal',
      conversationId: 'conversation',
      objective: 'Execute a tracked plan',
    })
    const run = repository.startRun({
      id: 'run',
      conversationId: 'conversation',
      goalId: goal.id,
    })

    const first = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: run.id,
      explanation: 'Initial repository-backed plan.',
      items: [
        { step: 'Inspect the existing schema', status: 'completed' },
        { step: 'Implement the migration', status: 'in_progress' },
        { step: 'Run focused tests', status: 'pending' },
      ],
    })
    expect(first).toMatchObject({
      goalId: goal.id,
      revision: 1,
      goalRevision: 2,
      runId: run.id,
      items: [
        { step: 'Inspect the existing schema', status: 'completed' },
        { step: 'Implement the migration', status: 'in_progress' },
        { step: 'Run focused tests', status: 'pending' },
      ],
    })
    expect(repository.getGoal(goal.id)).toMatchObject({ revision: 2, planRevision: 1 })
    expect(() =>
      repository.appendGoalPlan({
        goalId: goal.id,
        expectedGoalRevision: 2,
        items: [
          { step: 'First active step', status: 'in_progress' },
          { step: 'Second active step', status: 'in_progress' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() =>
      repository.appendGoalPlan({
        goalId: goal.id,
        expectedGoalRevision: 2,
        items: Array.from({ length: 51 }, (_, index) => ({
          step: `Step ${index}`,
          status: 'pending' as const,
        })),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    const second = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: 2,
      explanation: 'All implementation work is done.',
      items: [
        { step: 'Inspect the existing schema', status: 'completed' },
        { step: 'Implement the migration', status: 'completed' },
        { step: 'Run focused tests', status: 'completed' },
      ],
    })
    expect(second).toMatchObject({ revision: 2, goalRevision: 3 })
    expect(repository.getCurrentGoalPlan(goal.id)).toEqual(second)
    expect(repository.listGoalPlanRevisions(goal.id).map(({ revision }) => revision)).toEqual([
      2, 1,
    ])
    expect(() =>
      repository.appendGoalPlan({
        goalId: goal.id,
        expectedGoalRevision: 2,
        items: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    repository.close()

    const inspection = new DatabaseSync(databasePath)
    expect(() =>
      inspection
        .prepare("UPDATE goal_plan_revisions SET explanation = 'tampered' WHERE goal_id = 'goal'")
        .run(),
    ).toThrow(/immutable/)
    inspection.exec('DROP TRIGGER goal_plan_revisions_immutable')
    inspection
      .prepare("UPDATE goal_plan_revisions SET items_json = 'not-json' WHERE goal_id = 'goal'")
      .run()
    inspection.close()

    const corrupted = new ConversationRepository({ databasePath })
    expect(() => corrupted.getCurrentGoalPlan(goal.id)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    )
    corrupted.close()
  })

  it('records immutable checkpoints and cumulative token usage', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation' })
    const goal = repository.createGoal({
      id: 'goal',
      conversationId: 'conversation',
      objective: 'Persist progress checkpoints',
      tokenBudget: 1_000,
    })
    const run = repository.startRun({
      id: 'run',
      conversationId: 'conversation',
      goalId: goal.id,
    })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      items: [{ step: 'Record progress', status: 'in_progress' }],
    })
    const checkpoint = repository.appendGoalCheckpoint({
      goalId: goal.id,
      expectedGoalRevision: plan.goalRevision,
      runId: run.id,
      summary: 'The first durable checkpoint was recorded.',
      usedTokens: 320,
    })
    expect(checkpoint).toMatchObject({
      goalId: goal.id,
      goalRevision: 3,
      planRevision: 1,
      runId: run.id,
      status: 'active',
      summary: 'The first durable checkpoint was recorded.',
      usedTokens: 320,
    })
    expect(repository.getGoal(goal.id)).toMatchObject({
      revision: 3,
      progressSummary: checkpoint.summary,
      usedTokens: 320,
    })
    expect(() =>
      repository.appendGoalCheckpoint({
        goalId: goal.id,
        expectedGoalRevision: 3,
        summary: 'Invalid token regression',
        usedTokens: 319,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(repository.listGoalCheckpoints(goal.id)).toEqual([checkpoint])
    repository.close()

    const inspection = new DatabaseSync(databasePath)
    expect(() =>
      inspection
        .prepare("UPDATE goal_checkpoints SET summary = 'tampered' WHERE goal_id = 'goal'")
        .run(),
    ).toThrow(/immutable/)
    inspection.close()
  })

  it('rolls back run completion when its revision-bound Goal finish cannot commit', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      id: 'goal',
      workspacePath: '/workspace',
      objective: 'Finish atomically with the bounded run',
    })
    repository.startRun({ id: 'run', conversationId: 'conversation', goalId: goal.id })
    repository.appendMessage({
      id: 'assistant',
      conversationId: 'conversation',
      role: 'assistant',
      displayContent: 'Ready to finish',
      runId: 'run',
      status: 'running',
    })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: 'run',
      items: [{ step: 'Verify the result', status: 'completed' }],
    })
    const checkpoint = repository.appendGoalCheckpoint({
      goalId: goal.id,
      expectedGoalRevision: plan.goalRevision,
      runId: 'run',
      summary: 'The current plan was verified.',
    })
    repository.updateGoal(goal.id, {
      expectedRevision: checkpoint.goalRevision,
      tokenBudget: 1_000,
    })

    expect(() =>
      repository.finishRun('run', {
        status: 'completed',
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 1, totalTokens: 17 },
        goalFinish: {
          goalId: goal.id,
          expectedRevision: checkpoint.goalRevision,
          status: 'completed',
          summary: 'This stale finish must not commit.',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))

    expect(repository.getConversation('conversation')).toMatchObject({
      runs: [
        expect.objectContaining({
          id: 'run',
          status: 'running',
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        }),
      ],
      messages: [expect.objectContaining({ id: 'assistant', status: 'running' })],
    })
    expect(repository.getGoal(goal.id)).toMatchObject({
      status: 'active',
      revision: checkpoint.goalRevision + 1,
      usedTokens: 0,
    })

    repository.finishRun('run', { status: 'error', error: 'Stale goal finish rejected.' })
    expect(repository.getConversation('conversation')).toMatchObject({
      runs: [expect.objectContaining({ id: 'run', status: 'error' })],
      messages: [expect.objectContaining({ id: 'assistant', status: 'error' })],
    })
    repository.close()
  })

  it('keeps idempotent Goal finish snapshots bound to their owning run', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    const goal = repository.createGoal({
      workspacePath: '/workspace',
      objective: 'Bind completion to the evidence run',
    })
    repository.startRun({ id: 'goal-run', conversationId: 'conversation', goalId: goal.id })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: 'goal-run',
      items: [{ step: 'Verify ownership', status: 'completed' }],
    })
    const checkpoint = repository.appendGoalCheckpoint({
      goalId: goal.id,
      expectedGoalRevision: plan.goalRevision,
      runId: 'goal-run',
      summary: 'Ownership verified.',
    })
    const goalFinish = {
      goalId: goal.id,
      expectedRevision: checkpoint.goalRevision,
      status: 'completed' as const,
      summary: 'Completed by the owning run.',
    }
    repository.finishRun('goal-run', { status: 'completed', goalFinish })
    expect(repository.getGoal(goal.id)).toMatchObject({
      status: 'completed',
      completionSummary: goalFinish.summary,
    })
    expect(() =>
      repository.startRun({
        id: 'late-goal-run',
        conversationId: 'conversation',
        goalId: goal.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))

    repository.startRun({ id: 'unrelated-run', conversationId: 'conversation' })
    repository.finishRun('unrelated-run', { status: 'completed' })
    expect(() =>
      repository.finishRun('unrelated-run', { status: 'completed', goalFinish }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))

    const manuallyFinished = repository.createGoal({
      id: 'manually-finished-goal',
      workspacePath: '/workspace',
      objective: 'Do not infer run provenance from matching state',
    })
    repository.startRun({
      id: 'linked-without-finish',
      conversationId: 'conversation',
      goalId: manuallyFinished.id,
    })
    repository.finishRun('linked-without-finish', { status: 'completed' })
    repository.updateGoal(manuallyFinished.id, {
      expectedRevision: manuallyFinished.revision,
      status: 'completed',
      completionSummary: 'Completed explicitly outside the run.',
    })
    expect(() =>
      repository.finishRun('linked-without-finish', {
        status: 'completed',
        goalFinish: {
          goalId: manuallyFinished.id,
          expectedRevision: manuallyFinished.revision,
          status: 'completed',
          summary: 'Completed explicitly outside the run.',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
    repository.close()
  })
})

describe('ConversationRepository durable subagents', () => {
  it('tracks nested subagents, validates ownership, and finishes idempotently', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    repository.ensureConversation({ id: 'other-conversation', workspacePath: '/other-workspace' })
    const origin = repository.startRun({ id: 'origin', conversationId: 'conversation' })
    const goal = repository.createGoal({
      id: 'goal',
      conversationId: 'conversation',
      objective: 'Delegate independent repository audits',
    })
    const parent = repository.startSubagentRun({
      id: 'parent',
      conversationId: 'conversation',
      goalId: goal.id,
      originRunId: origin.id,
      name: 'architecture-audit',
      task: 'Inspect the persistence design.',
    })
    const child = repository.startSubagentRun({
      id: 'child',
      conversationId: 'conversation',
      parentSubagentRunId: parent.id,
      name: 'schema-audit',
      task: 'Inspect the schema invariants.',
    })
    expect(child).toMatchObject({
      goalId: goal.id,
      parentSubagentRunId: parent.id,
      status: 'running',
    })
    expect(() =>
      repository.startSubagentRun({
        conversationId: 'other-conversation',
        goalId: goal.id,
        name: 'cross-thread',
        task: 'This must fail.',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    const completed = repository.finishSubagentRun(child.id, {
      status: 'completed',
      resultSummary: 'The schema invariants are sound.',
    })
    expect(completed).toMatchObject({
      status: 'completed',
      resultSummary: 'The schema invariants are sound.',
      finishedAt: expect.any(Number),
    })
    expect(repository.finishSubagentRun(child.id, { status: 'completed' })).toEqual(completed)
    expect(() =>
      repository.finishSubagentRun(child.id, {
        status: 'error',
        error: 'Cannot overwrite terminal state',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
    expect(() =>
      repository.startSubagentRun({
        conversationId: 'conversation',
        parentSubagentRunId: child.id,
        name: 'late-child',
        task: 'Cannot start under a completed parent.',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
    expect(repository.listSubagentRuns('conversation', { goalId: goal.id })).toEqual([
      parent,
      completed,
    ])
    repository.close()
  })

  it('recovers all running subagents as interrupted exactly once', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation' })
    repository.startSubagentRun({
      id: 'first',
      conversationId: 'conversation',
      name: 'first-agent',
      task: 'Long-running task one.',
    })
    repository.startSubagentRun({
      id: 'second',
      conversationId: 'conversation',
      name: 'second-agent',
      task: 'Long-running task two.',
    })
    repository.finishSubagentRun('second', {
      status: 'completed',
      resultSummary: 'Finished before restart.',
    })
    repository.close()

    const reopened = new ConversationRepository({ databasePath })
    const recoveryReason = hostMessages('en').recovery.interruptedSubagentReason
    expect(reopened.recoverInterruptedSubagentRuns(recoveryReason)).toEqual({
      runIds: ['first'],
    })
    expect(reopened.getSubagentRun('first')).toMatchObject({
      status: 'interrupted',
      error: recoveryReason,
      finishedAt: expect.any(Number),
    })
    expect(reopened.getSubagentRun('second')).toMatchObject({ status: 'completed' })
    expect(reopened.recoverInterruptedSubagentRuns()).toEqual({ runIds: [] })
    reopened.close()
  })
})

describe('ConversationRepository filtering and safety boundaries', () => {
  it('atomically rejects cross-conversation message ids and ownership-bound updates', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({ id: 'victim-conversation', workspacePath: '/workspace-a' })
    repository.appendMessage({
      id: 'victim-message',
      conversationId: 'victim-conversation',
      role: 'assistant',
      displayContent: 'immutable victim content',
      status: 'completed',
    })

    expect(() =>
      repository.initializeRun({
        conversation: {
          id: 'attacker-conversation',
          status: 'active',
          workspacePath: '/workspace-b',
        },
        run: { id: 'attacker-run', conversationId: 'attacker-conversation' },
        userMessage: {
          id: 'attacker-user',
          conversationId: 'attacker-conversation',
          role: 'user',
          displayContent: 'attack',
          runId: 'attacker-run',
          status: 'running',
        },
        assistantMessage: {
          id: 'victim-message',
          conversationId: 'attacker-conversation',
          role: 'assistant',
          displayContent: '',
          runId: 'attacker-run',
          status: 'running',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))

    expect(repository.getConversation('victim-conversation')?.messages).toEqual([
      expect.objectContaining({
        id: 'victim-message',
        displayContent: 'immutable victim content',
        status: 'completed',
      }),
    ])
    expect(repository.getConversation('attacker-conversation')).toBeNull()
    expect(() =>
      repository.updateMessage(
        'victim-message',
        { displayContent: 'overwritten' },
        {
          conversationId: 'attacker-conversation',
          runId: 'attacker-run',
          role: 'assistant',
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(repository.getConversation('victim-conversation')?.messages[0]).toMatchObject({
      displayContent: 'immutable victim content',
    })
    repository.ensureConversation({ id: 'attacker-conversation', workspacePath: '/workspace-b' })
    repository.startRun({ id: 'victim-run', conversationId: 'victim-conversation' })
    expect(() =>
      repository.appendMessage({
        id: 'cross-run-message',
        conversationId: 'attacker-conversation',
        role: 'assistant',
        displayContent: 'invalid ownership',
        runId: 'victim-run',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    repository.appendMessage({
      id: 'attacker-message',
      conversationId: 'attacker-conversation',
      role: 'assistant',
      displayContent: 'unowned',
    })
    expect(() =>
      repository.updateMessage('attacker-message', { runId: 'victim-run' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    repository.close()
  })

  it('refuses to open a database created by a newer schema version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-assistant-conversations-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'future.sqlite3')
    const future = new DatabaseSync(databasePath)
    future.exec('PRAGMA user_version = 999')
    future.close()

    expect(() => new ConversationRepository({ databasePath })).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_TOO_NEW' }),
    )
  })

  it('searches summary and messages while respecting workspace and archive filters', () => {
    const { repository } = temporaryRepository()
    repository.ensureConversation({
      id: 'first',
      summary: 'Persistence design',
      workspacePath: '/workspace/a',
    })
    repository.appendMessage({
      conversationId: 'first',
      role: 'user',
      displayContent: 'Find the transaction boundary',
    })
    repository.ensureConversation({
      id: 'second',
      summary: '100% literal coverage',
      workspacePath: '/workspace/b',
    })
    repository.archive('second')

    expect(repository.listConversations({ search: 'transaction' }).map(({ id }) => id)).toEqual([
      'first',
    ])
    expect(repository.listConversations({ search: '%' }).map(({ id }) => id)).toEqual(['second'])
    expect(
      repository.listConversations({ workspacePath: '/workspace/a' }).map(({ id }) => id),
    ).toEqual(['first'])
    expect(repository.listConversations({ archived: true }).map(({ id }) => id)).toEqual(['second'])
    repository.close()
  })

  it('rejects arbitrary source/tool-result payloads and tolerates corrupt persisted JSON', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation' })
    expect(() =>
      repository.appendMessage({
        conversationId: 'conversation',
        role: 'assistant',
        displayContent: 'Summary only',
        toolActivities: [
          {
            callId: 'call',
            tool: 'read_file',
            summary: 'Read complete',
            status: 'completed',
            result: 'raw source contents',
          },
        ],
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() =>
      repository.appendMessage({
        conversationId: 'conversation',
        role: 'user',
        displayContent: 'Allowed prompt',
        sourceContent: 'raw source contents',
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    repository.appendMessage({
      id: 'message',
      conversationId: 'conversation',
      role: 'user',
      displayContent: 'Persisted prompt',
      contextPaths: ['src/index.ts'],
    })
    repository.close()

    const corruptor = new DatabaseSync(databasePath)
    corruptor
      .prepare(
        "UPDATE messages SET context_paths_json = 'not-json', tool_activities_json = '{broken' WHERE id = 'message'",
      )
      .run()
    corruptor.close()

    const reopened = new ConversationRepository({ databasePath })
    expect(reopened.getConversation('conversation')?.messages[0]).toMatchObject({
      contextPaths: [],
      toolActivities: [],
    })
    reopened.close()
  })

  it('deletes conversation-owned history without deleting independent goal state', () => {
    const { repository, databasePath } = temporaryRepository()
    repository.ensureConversation({ id: 'conversation', workspacePath: '/workspace' })
    repository.appendMessage({
      conversationId: 'conversation',
      role: 'user',
      displayContent: 'Delete this conversation',
    })
    const goal = repository.createGoal({
      id: 'goal',
      conversationId: 'conversation',
      objective: 'Delete the complete thread graph',
    })
    repository.startRun({ id: 'run', conversationId: 'conversation', goalId: goal.id })
    const plan = repository.appendGoalPlan({
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      runId: 'run',
      items: [{ step: 'Delete everything', status: 'in_progress' }],
    })
    const subagent = repository.startSubagentRun({
      id: 'subagent',
      conversationId: 'conversation',
      goalId: goal.id,
      name: 'delete-audit',
      task: 'Verify cascading deletion.',
    })
    repository.appendGoalCheckpoint({
      goalId: goal.id,
      expectedGoalRevision: plan.goalRevision,
      subagentRunId: subagent.id,
      summary: 'The graph is ready for deletion.',
    })
    repository.appendAuditEvent({
      conversationId: 'conversation',
      type: 'test.event',
      summary: 'Audit record',
    })
    expect(repository.delete('conversation')).toBe(true)
    expect(repository.delete('conversation')).toBe(false)
    const detached = repository.getGoal(goal.id)
    expect(detached).toMatchObject({
      originConversationId: null,
      conversationId: null,
      workspacePath: '/workspace',
      status: 'active',
    })
    expect(repository.getCurrentGoalPlan(goal.id)).toMatchObject({ runId: null })
    expect(repository.listGoalCheckpoints(goal.id)).toEqual([
      expect.objectContaining({ subagentRunId: null }),
    ])
    expect(repository.getSubagentRun(subagent.id)).toBeNull()
    const paused = repository.updateGoal(goal.id, {
      expectedRevision: detached?.revision ?? 0,
      status: 'paused',
      progressSummary: 'The origin conversation was removed without clearing the goal.',
    })
    expect(paused).toMatchObject({ status: 'paused', originConversationId: null })
    repository.close()

    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    for (const table of ['conversations', 'messages', 'runs', 'subagent_runs']) {
      expect(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({
        count: 0,
      })
    }
    for (const table of ['goals', 'goal_plan_revisions', 'goal_checkpoints', 'audit_events']) {
      expect(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({
        count: 1,
      })
    }
    inspection.close()
  })
})

function repositoryClosedError(repository: ConversationRepository): string | undefined {
  try {
    repository.listConversations()
    return undefined
  } catch (error) {
    return (error as ConversationRepositoryError).code
  }
}
