/** Studio-aligned mode / permission for Cherry `coco` agents. Isolated from native AgentPermissionMode. */

export const COCO_AGENT_MODES = ['agent', 'plan', 'ask', 'debug', 'multitask'] as const
export type CocoAgentMode = (typeof COCO_AGENT_MODES)[number]

export const COCO_AGENT_PERMISSIONS = ['ask', 'auto', 'read_only'] as const
export type CocoAgentPermission = (typeof COCO_AGENT_PERMISSIONS)[number]

export const DEFAULT_COCO_MODE: CocoAgentMode = 'agent'
export const DEFAULT_COCO_PERMISSION: CocoAgentPermission = 'ask'

export function isCocoAgentMode(value: unknown): value is CocoAgentMode {
  return typeof value === 'string' && (COCO_AGENT_MODES as readonly string[]).includes(value)
}

export function isCocoAgentPermission(value: unknown): value is CocoAgentPermission {
  return typeof value === 'string' && (COCO_AGENT_PERMISSIONS as readonly string[]).includes(value)
}

export function readCocoMode(configuration: unknown): CocoAgentMode {
  if (!configuration || typeof configuration !== 'object') return DEFAULT_COCO_MODE
  const value = (configuration as { coco_mode?: unknown }).coco_mode
  return isCocoAgentMode(value) ? value : DEFAULT_COCO_MODE
}

export function readCocoPermission(configuration: unknown): CocoAgentPermission {
  if (!configuration || typeof configuration !== 'object') return DEFAULT_COCO_PERMISSION
  const value = (configuration as { coco_permission?: unknown }).coco_permission
  return isCocoAgentPermission(value) ? value : DEFAULT_COCO_PERMISSION
}

export const COCO_MODE_CARDS: readonly {
  value: CocoAgentMode
  labelKey: string
  labelFallback: string
  descriptionKey: string
  descriptionFallback: string
}[] = [
  {
    value: 'agent',
    labelKey: 'library.config.agent.field.coco_mode.option.agent',
    labelFallback: 'Agent',
    descriptionKey: 'library.config.agent.field.coco_mode.option.agent_description',
    descriptionFallback: 'Build and edit the session canvas with Pipeline Script.'
  },
  {
    value: 'plan',
    labelKey: 'library.config.agent.field.coco_mode.option.plan',
    labelFallback: 'Plan',
    descriptionKey: 'library.config.agent.field.coco_mode.option.plan_description',
    descriptionFallback: 'Plan the graph without submitting a run.'
  },
  {
    value: 'ask',
    labelKey: 'library.config.agent.field.coco_mode.option.ask',
    labelFallback: 'Ask',
    descriptionKey: 'library.config.agent.field.coco_mode.option.ask_description',
    descriptionFallback: 'Read-only questions about the current canvas.'
  },
  {
    value: 'debug',
    labelKey: 'library.config.agent.field.coco_mode.option.debug',
    labelFallback: 'Debug',
    descriptionKey: 'library.config.agent.field.coco_mode.option.debug_description',
    descriptionFallback: 'Inspect diagnostics and failed nodes.'
  },
  {
    value: 'multitask',
    labelKey: 'library.config.agent.field.coco_mode.option.multitask',
    labelFallback: 'Multitask',
    descriptionKey: 'library.config.agent.field.coco_mode.option.multitask_description',
    descriptionFallback: 'Coordinate several canvas tasks in one session.'
  }
]

export const COCO_PERMISSION_CARDS: readonly {
  value: CocoAgentPermission
  labelKey: string
  labelFallback: string
  descriptionKey: string
  descriptionFallback: string
}[] = [
  {
    value: 'ask',
    labelKey: 'library.config.agent.field.coco_permission.option.ask',
    labelFallback: 'Ask',
    descriptionKey: 'library.config.agent.field.coco_permission.option.ask_description',
    descriptionFallback: 'Show a script diff and wait before applying it to this session canvas.'
  },
  {
    value: 'auto',
    labelKey: 'library.config.agent.field.coco_permission.option.auto',
    labelFallback: 'Auto',
    descriptionKey: 'library.config.agent.field.coco_permission.option.auto_description',
    descriptionFallback: 'Apply a valid Pipeline Script proposal to this session canvas immediately.'
  },
  {
    value: 'read_only',
    labelKey: 'library.config.agent.field.coco_permission.option.read_only',
    labelFallback: 'Read only',
    descriptionKey: 'library.config.agent.field.coco_permission.option.read_only_description',
    descriptionFallback: 'Inspect the canvas; do not propose or submit writes.'
  }
]
