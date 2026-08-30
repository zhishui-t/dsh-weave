import { WeaveError } from '../weave-error.js'
import type { ObsidianService } from './obsidian-service.js'

/**
 * Obsidian 独立 CLI 解析器（doc/09 §2.3）。
 *
 * 供 /weave obsidian ... 使用；也暴露为独立 `ObsidianCli`，便于测试或未来单独入口。
 * 命令：
 *   /weave obsidian generate [--vault <path>] [--force]
 *   /weave obsidian open [--vault <path>]
 *   /weave obsidian reindex [--vault <path>]
 *   /weave obsidian status [--vault <path>]
 *   /weave obsidian conflicts [--vault <path>]
 */

interface ParsedCliArgs {
  positionals: string[]
  flags: Map<string, string>
}

const USAGE = [
  '用法: /weave obsidian generate|open|reindex|status|conflicts [--vault <path>]',
  '  generate [--vault <path>] [--force]',
  '  open     [--vault <path>]',
  '  reindex  [--vault <path>]',
  '  status   [--vault <path>]',
  '  conflicts [--vault <path>]',
].join('\n')

export interface ObsidianCliResult {
  text: string
  data: unknown
}

export function parseObsidianCliArgs(args: string[]): ParsedCliArgs {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      } else {
        flags.set(name, '')
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

export class ObsidianCli {
  readonly #service: ObsidianService

  constructor(service: ObsidianService) {
    this.#service = service
  }

  /** 执行 obsidian 子命令；返回人类可读 text + 结构化 data。 */
  async run(argv: string[]): Promise<ObsidianCliResult> {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
      return { text: USAGE, data: { help: true } }
    }
    const [command, ...rest] = argv
    const { flags } = parseObsidianCliArgs(rest)
    const vaultPath = flags.get('vault') || undefined

    switch (command) {
      case 'generate': {
        const force = flags.has('force')
        const result = await this.#service.generate({ vaultPath, force })
        const lines = [
          `Vault: ${result.vaultPath}`,
          `新增: ${result.generated}`,
          `更新: ${result.updated}`,
          `冲突: ${result.conflictCount}`,
          ...(result.existingSkipped !== undefined ? [`已跳过已有文件: ${result.existingSkipped}`] : []),
          ...(result.tombstones && result.tombstones.length > 0 ? [`墓碑: ${result.tombstones.length}`] : []),
          ...(result.aliases && result.aliases.length > 0 ? [`别名: ${result.aliases.length}`] : []),
        ]
        return { text: lines.join('\n'), data: result }
      }
      case 'open': {
        const result = await this.#service.open({ vaultPath })
        return { text: `Obsidian 协议: ${result.uri}\n路径: ${result.vaultPath}`, data: result }
      }
      case 'reindex': {
        const result = await this.#service.reindex({ vaultPath })
        return {
          text: `已重新索引 ${result.entries} 个 Markdown（冲突 ${result.conflictCount}）\nVault: ${result.vaultPath}`,
          data: result,
        }
      }
      case 'status': {
        const result = await this.#service.status({ vaultPath })
        const lines = [
          `Vault: ${result.vaultPath}`,
          `存在: ${result.exists ? '是' : '否'}`,
          ...(result.lastGeneratedAt ? [`最近生成: ${result.lastGeneratedAt}`] : []),
          `冲突: ${result.conflictCount}`,
          ...(result.fileCount !== undefined ? [`Markdown 文件: ${result.fileCount}`] : []),
          ...(result.knowledgeCount !== undefined ? [`知识条数: ${result.knowledgeCount}`] : []),
        ]
        return { text: lines.join('\n'), data: result }
      }
      case 'conflicts': {
        const result = await this.#service.conflicts({ vaultPath })
        const lines = [
          ...result.conflicts.map((conflict) => `- ${conflict.path} [${conflict.kind}]${conflict.backupPath ? ` Weave 备份: ${conflict.backupPath}` : ''}`),
          ...(result.tombstones && result.tombstones.length > 0 ? ['', '墓碑:'] : []),
          ...(result.tombstones ?? []).map((t) => `- ${t.path} [${t.detectedAt}]`),
          ...(result.aliases && result.aliases.length > 0 ? ['', '别名:'] : []),
          ...(result.aliases ?? []).map((a) => `- ${a.from} → ${a.to} [${a.detectedAt}]`),
        ]
        return {
          text: lines.length > 0 ? lines.join('\n') : '（无冲突）',
          data: result,
        }
      }
      default:
        throw new WeaveError('invalid_argument', '用法: /weave obsidian generate|open|reindex|status|conflicts [--vault <path>]')
    }
  }
}
