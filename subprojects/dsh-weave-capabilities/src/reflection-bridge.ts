import type { ReflectionDepositInput, ReflectionDepositResult } from './reflection-service.js'

/** Structural fork task-settled payload (see AgentTeamsHostHooks). */
export interface AgentTeamsTaskSettledLike {
  teamId: string
  teamProfileName?: string
  taskId: string
  taskSubject?: string
  taskStatus: 'completed' | 'failed' | 'cancelled' | string
  memberName?: string
  memberRole?: string
  memberExecutor?: string
  output?: string
}

export interface ReflectionLike {
  depositFromOutput(input: ReflectionDepositInput): Promise<ReflectionDepositResult>
}

export function mapTaskSettled(input: AgentTeamsTaskSettledLike): ReflectionDepositInput | null {
  if (input.taskStatus !== 'completed' && input.taskStatus !== 'failed') return null
  return {
    taskId: input.taskId,
    executor: input.memberExecutor ?? 'unknown',
    roleId: input.memberRole ?? input.memberName ?? 'unknown',
    projectId: input.teamProfileName ?? input.teamId,
    version: input.teamId,
    outputText: input.output ?? '',
    ...input.taskSubject ? { taskSubject: input.taskSubject } : {},
  }
}

export class ReflectionBridge {
  readonly #reflection: ReflectionLike

  constructor(reflection: ReflectionLike) {
    this.#reflection = reflection
  }

  async onTaskSettled(input: AgentTeamsTaskSettledLike): Promise<ReflectionDepositResult | null> {
    const mapped = mapTaskSettled(input)
    if (mapped === null) return null
    return this.#reflection.depositFromOutput(mapped)
  }
}
