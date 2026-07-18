import type {
  CreateGoalInput,
  GoalDetail,
  GoalStatus,
  GoalSummary,
  MutateGoalInput,
} from '@shared/contracts'
import {
  AlertCircle,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  Flag,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { type TranslationKey, useI18n } from './i18n'
import { useModalFocus } from './modal-focus'

const OPEN_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked'])

const STATUS_KEYS: Record<GoalStatus, TranslationKey> = {
  active: 'goals.status.active',
  paused: 'goals.status.paused',
  blocked: 'goals.status.blocked',
  completed: 'goals.status.completed',
  cleared: 'goals.status.cleared',
}

const TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

export interface GoalsModalProps {
  goals: GoalSummary[]
  showAll: boolean
  detail: GoalDetail | null
  loading: boolean
  error: string | null
  busyId: string | null
  running: boolean
  onRefresh: () => void
  onShowAllChange: (showAll: boolean) => void
  onSelect: (goalId: string) => Promise<void>
  onCreate: (input: CreateGoalInput) => Promise<void>
  onMutate: (input: MutateGoalInput) => Promise<void>
  onRun: (goal: GoalSummary) => Promise<void>
  onClose: () => void
}

export function GoalsModal({
  goals,
  showAll,
  detail,
  loading,
  error,
  busyId,
  running,
  onRefresh,
  onShowAllChange,
  onSelect,
  onCreate,
  onMutate,
  onRun,
  onClose,
}: GoalsModalProps) {
  const { t, formatDateTime, formatNumber } = useI18n()
  const [creating, setCreating] = useState(false)
  const [objective, setObjective] = useState('')
  const [tokenBudget, setTokenBudget] = useState('')
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null)
  const [editObjective, setEditObjective] = useState('')
  const [editTokenBudget, setEditTokenBudget] = useState('')
  const [completionSummary, setCompletionSummary] = useState('')
  const [clearConfirmationGoalId, setClearConfirmationGoalId] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const visibleGoals = useMemo(
    () => (showAll ? goals : goals.filter((goal) => OPEN_STATUSES.has(goal.status))),
    [goals, showAll],
  )
  const selectedGoalRevision = detail
    ? `${detail.summary.id}:${detail.summary.revision.toString()}`
    : null

  useModalFocus({ dialogRef, initialFocusRef: closeButtonRef, onEscape: onClose })

  useEffect(() => {
    void selectedGoalRevision
    setEditingGoalId(null)
    setEditObjective('')
    setEditTokenBudget('')
    setCompletionSummary('')
    setClearConfirmationGoalId(null)
  }, [selectedGoalRevision])

  const submitGoal = async (event: FormEvent) => {
    event.preventDefault()
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : undefined
    try {
      await onCreate({
        objective: objective.trim(),
        ...(parsedBudget !== undefined ? { tokenBudget: parsedBudget } : {}),
      })
      setObjective('')
      setTokenBudget('')
      setCreating(false)
    } catch {
      // The parent keeps the form open and renders the validated IPC error.
    }
  }

  const mutate = async (input: MutateGoalInput) => {
    try {
      await onMutate(input)
      if (input.action === 'complete') setCompletionSummary('')
      if (input.action === 'clear') setClearConfirmationGoalId(null)
      setEditingGoalId(null)
      return true
    } catch {
      // The parent refreshes stale state and renders the failure.
      return false
    }
  }

  const selected =
    detail && visibleGoals.some((goal) => goal.id === detail.summary.id) ? detail.summary : null
  const selectedPlan = selected ? (detail?.plan ?? null) : null
  const selectedCheckpoints = selected ? (detail?.checkpoints ?? []) : []
  const interactionBusy = loading || Boolean(busyId)
  const parsedEditTokenBudget = editTokenBudget.trim() ? Number(editTokenBudget) : null
  const editTokenBudgetValid =
    parsedEditTokenBudget === null ||
    (Number.isSafeInteger(parsedEditTokenBudget) && parsedEditTokenBudget > 0)
  const editChanged = Boolean(
    selected &&
      (editObjective.trim() !== selected.objective ||
        parsedEditTokenBudget !== selected.tokenBudget),
  )
  const tokenPercent =
    selected?.tokenBudget && selected.tokenBudget > 0
      ? Math.min(100, Math.round((selected.usedTokens / selected.tokenBudget) * 100))
      : null

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="goals-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goals-title"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{t('goals.eyebrow')}</span>
            <h1 id="goals-title">{t('goals.title')}</h1>
            <p>{t('goals.description')}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('goals.close')}
          >
            <X size={18} />
          </button>
        </header>

        <div className="goals-toolbar">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setCreating((value) => !value)}
            disabled={interactionBusy}
          >
            <Plus size={14} /> {t('goals.new')}
          </button>
          <button
            type="button"
            className={`history-filter${showAll ? ' selected' : ''}`}
            onClick={() => onShowAllChange(!showAll)}
            aria-pressed={showAll}
            disabled={interactionBusy}
          >
            {showAll ? t('goals.filter.all') : t('goals.filter.open')}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onRefresh}
            disabled={interactionBusy}
            aria-label={t('goals.refresh')}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>

        {creating && (
          <form className="goal-create-form" onSubmit={(event) => void submitGoal(event)}>
            <label>
              <span>{t('goals.field.objective')}</span>
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder={t('goals.field.objectivePlaceholder')}
                maxLength={100_000}
                required
                disabled={Boolean(busyId)}
              />
            </label>
            <label>
              <span>{t('goals.field.tokenBudget')}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={tokenBudget}
                onChange={(event) => setTokenBudget(event.target.value)}
                placeholder={t('goals.field.tokenBudgetPlaceholder')}
                disabled={Boolean(busyId)}
              />
            </label>
            <div className="goal-form-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setCreating(false)}
                disabled={Boolean(busyId)}
              >
                {t('goals.cancel')}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={Boolean(busyId) || !objective.trim()}
              >
                <Target size={14} /> {t('goals.create')}
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="goals-error" role="alert">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        <div className="goals-body" aria-busy={loading}>
          <div className="goals-list">
            {loading && goals.length === 0 ? (
              <div className="modal-inline-state">
                <LoaderCircle className="spin" size={20} />
                <p>{t('goals.loading')}</p>
              </div>
            ) : visibleGoals.length === 0 ? (
              <div className="modal-inline-state">
                <Target size={22} />
                <p>{showAll ? t('goals.empty.all') : t('goals.empty.open')}</p>
              </div>
            ) : (
              visibleGoals.map((goal) => (
                <button
                  type="button"
                  className={`goal-list-item${detail?.summary.id === goal.id ? ' selected' : ''}`}
                  key={goal.id}
                  onClick={() => void onSelect(goal.id)}
                  disabled={interactionBusy}
                  aria-pressed={detail?.summary.id === goal.id}
                >
                  <span className={`goal-status-dot ${goal.status}`} aria-hidden="true" />
                  <span className="goal-list-copy">
                    <strong>{goal.objective}</strong>
                    <small>
                      {t(STATUS_KEYS[goal.status])} ·{' '}
                      {formatDateTime(goal.updatedAt, TIMESTAMP_OPTIONS)}
                    </small>
                  </span>
                  {busyId === goal.id ? <LoaderCircle className="spin" size={14} /> : null}
                </button>
              ))
            )}
          </div>

          <div className="goal-detail">
            {!selected ? (
              <div className="modal-inline-state">
                <Flag size={22} />
                <p>{t('goals.selectHint')}</p>
              </div>
            ) : (
              <>
                <div className="goal-detail-heading">
                  <span className={`goal-status-chip ${selected.status}`}>
                    {t(STATUS_KEYS[selected.status])}
                  </span>
                  <time dateTime={new Date(selected.updatedAt).toISOString()}>
                    {formatDateTime(selected.updatedAt, TIMESTAMP_OPTIONS)}
                  </time>
                  <h2>{selected.objective}</h2>
                  {selected.progressSummary && <p>{selected.progressSummary}</p>}
                  {selected.blockedSummary && (
                    <p className="danger-text">{selected.blockedSummary}</p>
                  )}
                  {selected.completionSummary && <p>{selected.completionSummary}</p>}
                </div>

                {editingGoalId === selected.id && (
                  <form
                    className="goal-edit-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!editTokenBudgetValid || !editChanged) return
                      void mutate({
                        action: 'edit',
                        goalId: selected.id,
                        expectedRevision: selected.revision,
                        objective: editObjective.trim(),
                        tokenBudget: parsedEditTokenBudget,
                      })
                    }}
                  >
                    <div className="goal-edit-fields">
                      <label>
                        <span>{t('goals.field.objective')}</span>
                        <textarea
                          value={editObjective}
                          onChange={(event) => setEditObjective(event.target.value)}
                          maxLength={100_000}
                          required
                          disabled={interactionBusy}
                        />
                      </label>
                      <label>
                        <span>{t('goals.field.tokenBudget')}</span>
                        <input
                          type="number"
                          min={1}
                          max={Number.MAX_SAFE_INTEGER}
                          step={1}
                          value={editTokenBudget}
                          onChange={(event) => setEditTokenBudget(event.target.value)}
                          placeholder={t('goals.field.tokenBudgetPlaceholder')}
                          disabled={interactionBusy}
                        />
                        <small>{t('goals.edit.tokenBudgetHint')}</small>
                      </label>
                    </div>
                    <div className="goal-form-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setEditingGoalId(null)}
                        disabled={interactionBusy}
                      >
                        {t('goals.cancel')}
                      </button>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={
                          interactionBusy ||
                          !editObjective.trim() ||
                          !editTokenBudgetValid ||
                          !editChanged
                        }
                      >
                        {t('goals.edit.save')}
                      </button>
                    </div>
                  </form>
                )}

                <div className="goal-budget">
                  <div>
                    <span>{t('goals.tokensUsed')}</span>
                    <strong>
                      {formatNumber(selected.usedTokens)}
                      {selected.tokenBudget ? ` / ${formatNumber(selected.tokenBudget)}` : ''}
                    </strong>
                  </div>
                  {tokenPercent !== null && (
                    <div
                      className="goal-progress"
                      role="progressbar"
                      aria-label={t('goals.tokenBudgetUsage')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={tokenPercent}
                    >
                      <span style={{ width: `${tokenPercent}%` }} />
                    </div>
                  )}
                </div>

                <section className="goal-section">
                  <h3>{t('goals.currentPlan')}</h3>
                  {selectedPlan?.items.length ? (
                    <ol className="goal-plan-list">
                      {selectedPlan.items.map((item, index) => (
                        <li key={`${selectedPlan.revision}:${index.toString()}`}>
                          <span className={`goal-plan-state ${item.status}`}>
                            {item.status === 'completed' ? <CheckCircle2 size={13} /> : index + 1}
                          </span>
                          <span>{item.step}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="goal-empty-copy">{t('goals.emptyPlan')}</p>
                  )}
                </section>

                <section className="goal-section">
                  <h3>{t('goals.recentCheckpoints')}</h3>
                  {selectedCheckpoints.length ? (
                    <ul className="goal-checkpoint-list">
                      {selectedCheckpoints.slice(0, 8).map((checkpoint) => (
                        <li key={checkpoint.id}>
                          <p>{checkpoint.summary}</p>
                          <time dateTime={new Date(checkpoint.createdAt).toISOString()}>
                            {formatDateTime(checkpoint.createdAt, TIMESTAMP_OPTIONS)}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="goal-empty-copy">{t('goals.emptyCheckpoints')}</p>
                  )}
                </section>

                {OPEN_STATUSES.has(selected.status) && (
                  <div className="goal-lifecycle-actions">
                    {selected.status === 'active' && (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={interactionBusy || running}
                        onClick={() => void onRun(selected)}
                      >
                        <Target size={14} /> {t('goals.runNow')}
                      </button>
                    )}
                    {selected.status === 'active' ? (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={interactionBusy}
                        onClick={() =>
                          void mutate({
                            action: 'pause',
                            goalId: selected.id,
                            expectedRevision: selected.revision,
                          })
                        }
                      >
                        <CirclePause size={14} /> {t('goals.pause')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={interactionBusy}
                        onClick={() =>
                          void mutate({
                            action: 'resume',
                            goalId: selected.id,
                            expectedRevision: selected.revision,
                          })
                        }
                      >
                        <CirclePlay size={14} /> {t('goals.resume')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={interactionBusy}
                      onClick={() => {
                        setEditingGoalId(selected.id)
                        setEditObjective(selected.objective)
                        setEditTokenBudget(selected.tokenBudget?.toString() ?? '')
                      }}
                    >
                      <Pencil size={14} /> {t('goals.edit')}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={interactionBusy}
                      onClick={() => {
                        if (clearConfirmationGoalId !== selected.id) {
                          setClearConfirmationGoalId(selected.id)
                          return
                        }
                        void mutate({
                          action: 'clear',
                          goalId: selected.id,
                          expectedRevision: selected.revision,
                        })
                      }}
                      aria-label={
                        clearConfirmationGoalId === selected.id
                          ? t('goals.clearConfirmLabel')
                          : t('goals.clearLabel')
                      }
                    >
                      <Trash2 size={14} />
                      {clearConfirmationGoalId === selected.id
                        ? t('goals.clearConfirm')
                        : t('goals.clear')}
                    </button>
                  </div>
                )}

                {selected.status === 'active' && (
                  <form
                    className="goal-complete-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void mutate({
                        action: 'complete',
                        goalId: selected.id,
                        expectedRevision: selected.revision,
                        summary: completionSummary.trim(),
                      })
                    }}
                  >
                    <label>
                      <span>{t('goals.completionEvidence')}</span>
                      <input
                        value={completionSummary}
                        onChange={(event) => setCompletionSummary(event.target.value)}
                        placeholder={t('goals.completionEvidencePlaceholder')}
                        maxLength={16_000}
                        disabled={interactionBusy}
                      />
                    </label>
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={interactionBusy || !completionSummary.trim()}
                    >
                      <CheckCircle2 size={14} /> {t('goals.complete')}
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
