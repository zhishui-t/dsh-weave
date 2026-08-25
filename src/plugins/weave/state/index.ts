export { WeaveError } from './weave-error.js'
export { TASK_STATUSES } from './types.js'
export type { TaskStatus, TaskRecord, TaskEdge, TaskDag } from './types.js'
export {
  TaskStateMachine,
  TASK_TRANSITIONS,
  FAILURE_TERMINALS,
  MAX_ACTIVATION_ITERATIONS,
} from './task-state-machine.js'
export type { StatusTransition, PropagationResult, ReactivationResult } from './task-state-machine.js'
