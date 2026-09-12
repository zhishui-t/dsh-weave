import type { PrismReflectionService } from '../prism/reflection.js'

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
 * 反思/记忆沉淀出口：进入知识暂存区（先审后发，approve 后落 Prism 知识库），
 * 而不是团队运行目录。这里只做薄适配，实际能力由 PrismReflectionService 提供。
 */
export class ReflectionSink {
  readonly #reflection: PrismReflectionService

  constructor(reflection: PrismReflectionService) {
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
