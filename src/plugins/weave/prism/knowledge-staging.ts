import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 知识暂存区（先审后发）。
 *
 * 执行器反思产物（WEAVE_KNOWLEDGE 块）不再直接落知识库：先写本暂存区，
 * 主会话（队长）经 weave_knowledge_review/approve/reject 审核后，
 * approve 才 deposit 进 Prism（prism deposit 即生效、版次制，无 candidate 态）。
 * 文件制（每条一个 JSON），不占用 SQLite——审核通过后暂存文件即删除，
 * 知识的唯一真相在 Prism。
 */

/** WEAVE_KNOWLEDGE 块类型（reflection.ts 解析产物）。 */
export type StagedKnowledgeType = 'pitfall' | 'pattern' | 'skill' | 'doc'

export interface StagedKnowledge {
  /** 暂存 id：`stag_<毫秒>_<短随机>` */
  id: string
  title: string
  type: StagedKnowledgeType
  content: string
  tags: string[]
  task_id: string
  role_id: string
  project_id: string
  version: string
  executor?: string
  /** ISO 时间 */
  deposited_at: string
}

export interface StagedKnowledgeInput {
  title: string
  type: StagedKnowledgeType
  content: string
  tags?: string[]
  task_id: string
  role_id: string
  project_id: string
  version: string
  executor?: string
}

export interface KnowledgeStagingOptions {
  dir?: string
  log?: Pick<Console, 'warn'>
}

export const DEFAULT_KNOWLEDGE_STAGING_DIR = join(homedir(), '.dsh', 'state', 'knowledge-staging')

export class KnowledgeStaging {
  readonly #dir: string
  readonly #log: Pick<Console, 'warn'>

  constructor(options: KnowledgeStagingOptions = {}) {
    this.#dir = options.dir ?? DEFAULT_KNOWLEDGE_STAGING_DIR
    this.#log = options.log ?? console
  }

  get dir(): string {
    return this.#dir
  }

  /** 追加一条暂存（自动建目录；id/时间戳在此生成）。 */
  async append(input: StagedKnowledgeInput): Promise<StagedKnowledge> {
    const entry: StagedKnowledge = {
      id: `stag_${Date.now()}_${randomUUID().slice(0, 8)}`,
      title: input.title,
      type: input.type,
      content: input.content,
      tags: input.tags ?? [],
      task_id: input.task_id,
      role_id: input.role_id,
      project_id: input.project_id,
      version: input.version,
      ...(input.executor !== undefined ? { executor: input.executor } : {}),
      deposited_at: new Date().toISOString(),
    }
    await mkdir(this.#dir, { recursive: true })
    await writeFile(join(this.#dir, `${entry.id}.json`), JSON.stringify(entry, null, 2), 'utf8')
    return entry
  }

  /** 全量暂存条目，按沉淀时间升序（先审先出）。损坏文件跳过并告警。 */
  async list(): Promise<StagedKnowledge[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      return []
    }
    const entries: StagedKnowledge[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.#dir, name), 'utf8')
        const parsed = JSON.parse(raw) as StagedKnowledge
        if (typeof parsed?.id === 'string' && typeof parsed?.title === 'string') {
          entries.push(parsed)
        }
      } catch (error) {
        this.#log.warn(`[dsh-weave] knowledge-staging: 跳过损坏的暂存文件 ${name}:`, error)
      }
    }
    return entries.sort((a, b) => a.deposited_at.localeCompare(b.deposited_at) || a.id.localeCompare(b.id))
  }

  async count(): Promise<number> {
    return (await this.list()).length
  }

  async get(id: string): Promise<StagedKnowledge | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
    try {
      const parsed = JSON.parse(await readFile(join(this.#dir, `${id}.json`), 'utf8')) as StagedKnowledge
      // 与 list() 同一形状校验：损坏/手改文件不在 approve 时炸出晦涩的信封错误。
      if (typeof parsed?.id !== 'string' || typeof parsed?.title !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  /** 移除暂存条目（approve 落库后 / reject 弃用后调用）。文件不存在返回 false。 */
  async remove(id: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return false
    try {
      await rm(join(this.#dir, `${id}.json`))
      return true
    } catch {
      return false
    }
  }
}
