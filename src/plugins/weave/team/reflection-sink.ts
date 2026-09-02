import type { ReflectionService } from '../reflection-service.js'

export interface TaskSettledInput {
  taskId: string
  executor: string
  roleId: string
  projectId: string
  version: string
  outputText: string
  taskSubject?: string
}

export interface ReflectionSinkResult {
  deposited: string[]
}

/**
 * 反思/记忆沉淀出口：必须进入 Weave 知识库，而不是团队运行目录。
 * 这里只做薄适配，实际能力由 ReflectionService 提供。
 */
export class ReflectionSink {
  readonly #reflection: ReflectionService

  constructor(reflection: ReflectionService) {
    this.#reflection = reflection
  }

  async deposit(input: TaskSettledInput): Promise<ReflectionSinkResult> {
    const result = await this.#reflection.depositFromOutput({
      taskId: input.taskId,
      executor: input.executor,
      roleId: input.roleId,
      projectId: input.projectId,
      version: input.version,
      outputText: input.outputText,
      ...(input.taskSubject !== undefined ? { taskSubject: input.taskSubject } : {}),
    })
    return { deposited: result.deposited.map((item) => item.title ?? '') }
  }
}
