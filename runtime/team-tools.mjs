export const TEAM_TOOL_DEFINITIONS = [
  {
    name: 'TeamCreate', description: 'Create or select a named Agent Team. Teammates are started by Agent with team_name and name.', input_schema: {
      type: 'object', properties: { team_name: { type: 'string' }, description: { type: 'string' } }, required: ['team_name'], additionalProperties: false,
    },
  },
  {
    name: 'TeamDelete', description: 'Stop all teammates and delete the team after all tasks and patches are settled.', input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'TaskCreate', description: 'Create a team task. Dependencies are task ids in blockedBy.', input_schema: {
      type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' }, activeForm: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'string' } }, owner: { type: 'string' } }, required: ['subject', 'description'], additionalProperties: false,
    },
  },
  {
    name: 'TaskGet', description: 'Get one team task.', input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  {
    name: 'TaskList', description: 'List all team tasks.', input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'TaskUpdate', description: 'Update or complete a team task. Completing captures its worktree patch.', input_schema: {
      type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, subject: { type: 'string' }, description: { type: 'string' }, activeForm: { type: 'string' }, owner: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'string' } } }, required: ['task_id'], additionalProperties: false,
    },
  },
  {
    name: 'SendMessage', description: 'Send a FIFO message to a teammate, lead, or * for broadcast. Supports shutdown_request/response.', input_schema: {
      type: 'object', properties: { to: { type: 'string' }, type: { type: 'string' }, message: { type: 'string' }, summary: { type: 'string' }, request_id: { type: 'string' } }, required: ['to', 'message'], additionalProperties: false,
    },
  },
  {
    name: 'TeamApplyPatch', description: 'Check and apply a completed teammate patch atomically to the lead workspace.', input_schema: {
      type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false,
    },
  },
]

const text = value => value == null ? '' : String(value)

export function createTeamTools(session, actor = 'lead') {
  const handler = async (name, input, context) => {
    if (context.signal?.aborted) throw new Error('Team operation aborted')
    switch (name) {
      case 'TeamCreate': return session.createTeam({ ...input, actor })
      case 'TeamDelete': return session.deleteTeam({ actor })
      case 'TaskCreate': return session.createTask({ ...input, actor })
      case 'TaskGet': return session.getTask({ id: input.task_id })
      case 'TaskList': return session.listTasks()
      case 'TaskUpdate': return session.updateTask({ ...input, id: input.task_id, actor })
      case 'SendMessage': return session.sendMessage({ ...input, content: text(input.message), actor })
      case 'TeamApplyPatch': return session.applyPatch({ ...input, id: input.task_id, actor })
      default: throw new Error(`Unknown team tool: ${name}`)
    }
  }
  const allowed = actor === 'lead'
    ? TEAM_TOOL_DEFINITIONS
    : TEAM_TOOL_DEFINITIONS.filter(definition => ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'SendMessage'].includes(definition.name))
  return allowed.map(definition => ({ ...definition, handler: (input, context) => handler(definition.name, input ?? {}, context) }))
}
