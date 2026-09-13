import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { PrismClient } from './prism-client.js'

/**
 * Prism 进程托管：插件加载时确保内嵌 prism serve 在本机运行（"一个插件整体"）。
 *
 * - 已有健康实例（用户/系统自启）→ 直接复用，绝不重复拉起；
 * - 无实例且允许自启 → 用宿主同款 node 拉起 prism serve 子进程（PRISM_HOME 隔离数据目录）；
 * - 脚本解析顺序：显式传入 > `WEAVE_PRISM_SCRIPT` > dev 约定（仓库同级 `../prism` 的 CLI dist）。
 *   打包部署时由 build 流程把 prism 发行布局 vendor 进插件（ WEAVE_PRISM_SCRIPT 指向它）。
 * - 宿主 Node < 22.5（prism 依赖 node:sqlite）时子进程会启动失败——health 轮询超时后
 *   给出可读 reason，调用方降级（知识能力暂不可用，不影响调度主链路）。
 */

export const DEFAULT_PRISM_PORT = 7777
/** 默认 prism 数据目录：收拢在 DSH 目录树下。 */
export const DEFAULT_PRISM_HOME = join(homedir(), '.dsh', 'prism')

export interface PrismSupervisorOptions {
  client: PrismClient
  port?: number
  /** prism 数据目录（PRISM_HOME）。 */
  prismHome?: string
  /** prism 可执行入口（CLI dist 的 index.js）。 */
  scriptPath?: string
  /** 是否允许自动拉起（缺省 true）。 */
  autoStart?: boolean
  /** 健康等待总时长 ms（缺省 20s）。 */
  startTimeoutMs?: number
  log?: Pick<Console, 'log' | 'warn'>
}

export interface PrismRuntimeStatus {
  running: boolean
  /** 本次调用是否拉起了新进程 */
  spawned: boolean
  script?: string
  pid?: number
  reason?: string
}

export interface PrismCliResult {
  code: number
  stdout: string
  stderr: string
}

function repoRoot(): string {
  // dist 布局：dist/plugins/weave/prism/*.js → 根目录四级向上；src 同构。
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

export class PrismSupervisor {
  /** 探活专用短超时 client：探活若继承 30s 业务超时，黑洞端点会吃满整个启动等待窗口。 */
  readonly #probeClient: PrismClient
  readonly #port: number
  readonly #prismHome: string
  readonly #scriptPath?: string
  readonly #autoStart: boolean
  readonly #startTimeoutMs: number
  readonly #log: Pick<Console, 'log' | 'warn'>
  #child: ChildProcess | undefined
  /** ensureRunning 串行化：并发调用（启动 fire-and-forget + 首次业务调用）只允许一次探活/拉起。 */
  #ensureInFlight: Promise<PrismRuntimeStatus> | undefined

  constructor(options: PrismSupervisorOptions) {
    this.#probeClient = new PrismClient({ baseUrl: options.client.baseUrl, timeoutMs: 1_000 })
    this.#port = options.port ?? DEFAULT_PRISM_PORT
    this.#prismHome = options.prismHome ?? DEFAULT_PRISM_HOME
    this.#scriptPath = options.scriptPath ?? process.env.WEAVE_PRISM_SCRIPT ?? undefined
    this.#autoStart = options.autoStart ?? true
    this.#startTimeoutMs = options.startTimeoutMs ?? 20_000
    this.#log = options.log ?? console
  }

  /** 解析 prism CLI/serve 入口：显式/env > 插件内 vendor 布局 > dev 同级仓库。 */
  resolveScript(): string | undefined {
    const candidates = [
      this.#scriptPath,
      join(repoRoot(), 'dist', 'vendor', 'prism', 'bin', 'prism.js'),
      join(repoRoot(), '..', 'prism', 'packages', 'cli', 'dist', 'index.js'),
    ].filter((path): path is string => typeof path === 'string' && path !== '')
    for (const candidate of candidates) {
      if (existsSync(candidate)) return resolve(candidate)
    }
    return undefined
  }

  /** 探活（一次性）。 */
  async probe(): Promise<boolean> {
    try {
      await this.#probeClient.health()
      return true
    } catch {
      return false
    }
  }

  /** 确保运行：健康则复用；否则按需拉起并轮询健康。绝不抛错——失败时返回 reason 供降级。
   *  串行化：并发调用共享同一次探活/拉起（避免双 spawn 后幸存者脱管成孤儿）。 */
  ensureRunning(): Promise<PrismRuntimeStatus> {
    this.#ensureInFlight ??= this.#ensureRunningInner().finally(() => {
      this.#ensureInFlight = undefined
    })
    return this.#ensureInFlight
  }

  async #ensureRunningInner(): Promise<PrismRuntimeStatus> {
    if (await this.probe()) {
      return { running: true, spawned: false }
    }
    if (!this.#autoStart) {
      return { running: false, spawned: false, reason: 'auto_start=false 且无运行中的 prism 实例' }
    }
    const script = this.resolveScript()
    if (!script) {
      return {
        running: false,
        spawned: false,
        reason: '未找到 prism CLI 入口（设置 WEAVE_PRISM_SCRIPT 或部署 vendor 布局）',
      }
    }
    let spawnError: Error | undefined
    try {
      const child = spawn(process.execPath, [script, 'serve', '--port', String(this.#port), '--host', '127.0.0.1'], {
        env: { ...process.env, PRISM_HOME: this.#prismHome },
        stdio: 'ignore',
        detached: false,
      })
      this.#child = child
      child.on('error', (error) => {
        spawnError = error
        this.#log.warn('[dsh-weave] prism serve 子进程异常:', error)
      })
      // 退出即解除跟踪：下次 ensureRunning 会重新拉起（崩溃自愈的按需入口）。
      child.on('exit', () => {
        if (this.#child === child) this.#child = undefined
      })
    } catch (error) {
      return {
        running: false,
        spawned: false,
        script,
        reason: `prism serve 拉起失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const deadline = Date.now() + this.#startTimeoutMs
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        return { running: false, spawned: true, script, reason: `prism serve 拉起失败: ${spawnError.message}` }
      }
      if (await this.probe()) {
        return { running: true, spawned: true, script, pid: this.#child?.pid }
      }
      // 子进程秒退（Node 版本不满足 node:sqlite 等）→ 提前结束等待
      if (this.#child?.exitCode !== null && this.#child?.exitCode !== undefined) {
        return {
          running: false,
          spawned: true,
          script,
          reason: `prism serve 启动即退出（exit=${this.#child.exitCode}）；常见原因：宿主 Node < 22.5（prism 需要 node:sqlite）`,
        }
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 500))
    }
    return { running: false, spawned: true, script, reason: `prism serve 健康等待超时（${this.#startTimeoutMs}ms）` }
  }

/** 解析 prism MCP stdio 入口：env > 插件内 vendor 布局 > dev 同级仓库。 */
  resolveMcpEntry(): string | undefined {
    const candidates = [
      process.env.WEAVE_PRISM_MCP_ENTRY,
      join(repoRoot(), 'dist', 'vendor', 'prism', 'packages', 'server', 'dist', 'mcp', 'server.js'),
      join(repoRoot(), '..', 'prism', 'packages', 'server', 'dist', 'mcp', 'server.js'),
    ].filter((path): path is string => typeof path === 'string' && path !== '')
    for (const candidate of candidates) {
      if (existsSync(candidate)) return resolve(candidate)
    }
    return undefined
  }

  /**
   * ACP 会话 mcp_servers 条目（agent 拉取 prism_kb_* 工具的通道）。
   * 形状对齐 ZCode MCP 配置（type:'stdio' + command/args/env）；入口缺失返回 undefined。
   */
  mcpServerEntry(): { name: string; type: 'stdio'; command: string; args: string[]; env: Record<string, string> } | undefined {
    const entry = this.resolveMcpEntry()
    if (!entry) return undefined
    return {
      name: 'prism',
      type: 'stdio',
      command: process.execPath,
      args: [entry],
      env: { PRISM_HOME: this.#prismHome },
    }
  }

  /** 运行 prism CLI 子命令（kb convert / kb export 等无 HTTP 路由的能力）。 */
  async runCli(args: string[], options: { timeoutMs?: number } = {}): Promise<PrismCliResult> {
    const script = this.resolveScript()
    if (!script) {
      throw new Error('未找到 prism CLI 入口（设置 WEAVE_PRISM_SCRIPT 或部署 vendor 布局）')
    }
    const timeoutMs = options.timeoutMs ?? 120_000
    return await new Promise<PrismCliResult>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, PRISM_HOME: this.#prismHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectRun(new Error(`prism cli 超时（${timeoutMs}ms）: ${args.join(' ')}`))
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        rejectRun(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveRun({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  /** 停掉本托管拉起的子进程（复用的外部实例不动）。 */
  stop(): void {
    const child = this.#child
    this.#child = undefined
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM')
      } catch {
        // 已退出的竞争窗口，忽略
      }
    }
  }
}
