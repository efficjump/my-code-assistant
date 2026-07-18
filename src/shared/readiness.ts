import type {
  ActionAvailability,
  ActionDescriptor,
  ReadinessActionId,
  ReadinessItem,
  ReadinessSnapshot,
} from './contracts'

export interface ReadinessInput {
  providerSelected: boolean
  modelSelected: boolean
  workspaceSelected: boolean
  workspaceTrusted: boolean
}

interface ActionState {
  availability: ActionAvailability
  reasonCode?: string
}

const ACTION_EFFECTS = {
  'settings.open-provider': [],
  'settings.select-model': [],
  'workspace.choose': ['read'],
  'workspace.trust': [],
  'conversation.start': [],
} as const satisfies Record<ReadinessActionId, readonly ActionDescriptor['effects'][number][]>

function action(id: ReadinessActionId, state: ActionState, revision: string): ActionDescriptor {
  return {
    id,
    source: 'host',
    effects: [...ACTION_EFFECTS[id]],
    availability: state.availability,
    reasonCode: state.reasonCode ?? null,
    revision,
  }
}

export function buildReadinessSnapshot(input: ReadinessInput): ReadinessSnapshot {
  const providerSelected = input.providerSelected
  const modelSelected = providerSelected && input.modelSelected
  const workspaceSelected = input.workspaceSelected
  const workspaceTrusted = workspaceSelected && input.workspaceTrusted
  const revision = [providerSelected, modelSelected, workspaceSelected, workspaceTrusted]
    .map((value) => (value ? '1' : '0'))
    .join('')

  const items: ReadinessItem[] = [
    {
      id: 'provider',
      status: providerSelected ? 'complete' : 'required',
      actionId: providerSelected ? null : 'settings.open-provider',
    },
    {
      id: 'model',
      status: modelSelected ? 'complete' : providerSelected ? 'required' : 'blocked',
      actionId: modelSelected ? null : 'settings.select-model',
    },
    {
      id: 'workspace',
      status: workspaceSelected ? 'complete' : 'recommended',
      actionId: workspaceSelected ? null : 'workspace.choose',
    },
    {
      id: 'trust',
      status: workspaceTrusted ? 'complete' : workspaceSelected ? 'restricted' : 'blocked',
      actionId: workspaceTrusted ? null : 'workspace.trust',
    },
  ]

  const actions = [
    action(
      'settings.open-provider',
      { availability: providerSelected ? 'hidden' : 'available' },
      revision,
    ),
    action(
      'settings.select-model',
      providerSelected
        ? { availability: modelSelected ? 'hidden' : 'available' }
        : { availability: 'blocked', reasonCode: 'provider-required' },
      revision,
    ),
    action(
      'workspace.choose',
      { availability: workspaceSelected ? 'hidden' : 'available' },
      revision,
    ),
    action(
      'workspace.trust',
      workspaceSelected
        ? { availability: workspaceTrusted ? 'hidden' : 'available' }
        : { availability: 'blocked', reasonCode: 'workspace-required' },
      revision,
    ),
    action(
      'conversation.start',
      modelSelected
        ? { availability: 'available' }
        : {
            availability: 'blocked',
            reasonCode: providerSelected ? 'model-required' : 'provider-required',
          },
      revision,
    ),
  ]

  if (!providerSelected || !modelSelected) {
    return {
      status: 'action-required',
      items,
      primaryActionId: providerSelected ? 'settings.select-model' : 'settings.open-provider',
      actions,
    }
  }

  if (!workspaceSelected || !workspaceTrusted) {
    return {
      status: 'restricted',
      items,
      primaryActionId: workspaceSelected ? 'workspace.trust' : 'workspace.choose',
      actions,
    }
  }

  return {
    status: 'ready',
    items,
    primaryActionId: 'conversation.start',
    actions,
  }
}
