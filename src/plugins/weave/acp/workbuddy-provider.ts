import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpSessionProviderConfig } from './acp-session-provider.js'

/**
 * WorkBuddy ACP 执行器接入（腾讯 WorkBuddy / CodeBuddy 引擎）。
 *
 * WorkBuddy 的原生 CLI 就是标准 ACP agent：
 *   <node> codebuddy --acp --permission-mode <mode>
 * 引擎复用 WorkBuddy 应用登录态（~/.codebuddy），支持 ACP session/load 续接——
 * 引擎空闲自动退出后，weave 的恢复链（load → resume → 新建自愈）原样可用。
 * 因此**不经过 wddy-acp MCP 桥**：weave 的 AcpSessionProvider 本身就是 ACP 客户端。
 *
 * 发现顺序：`WEAVE_WORKBUDDY_CLI` / `WORKBUDDY_CLI` env > WorkBuddy.app 内置 CLI（macOS）。
 * CLI 不存在 → 返回 undefined（不注册，执行器列表不出现 workbuddy）。
 *
 * 能力面：纯标准 ACP（declaredExtensions: []，无 zcode 扩展）→ 动态基线
 * （实时输出 / 会话复用 / 续接自愈）。CodeBuddy 支持 session/set_model 与
 * session/set_config_option（model/thought），待扩展协商面声明后再开放控制。
 *
 * 会话索引使用独立文件（见 DEFAULT_WORKBUDDY_ACP_SESSION_INDEX_FILE）：
 * sessionKey（团队:角色:项目:版本）不含执行器维度，与 zcode 共用索引会互相串会话线索。
 */

/** WorkBuddy.app 内置 CodeBuddy CLI（macOS 默认安装位置）。 */
export const DEFAULT_WORKBUDDY_CLI =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'

/** 引擎权限模式：fullAccess 与 WorkBuddy 应用自身行为一致（自动批准工具调用）。 */
export const DEFAULT_WORKBUDDY_PERMISSION_MODE = 'fullAccess'

/** workbuddy 专用 sessionKey→acpSid 持久索引（与 zcode 索引隔离）。 */
export const DEFAULT_WORKBUDDY_ACP_SESSION_INDEX_FILE = join(
  homedir(),
  '.dsh',
  'weave',
  'acp-workbuddy-session-index.json',
)

export function workbuddyAcpProviderConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AcpSessionProviderConfig | undefined {
  const cliPath = env.WEAVE_WORKBUDDY_CLI ?? env.WORKBUDDY_CLI ?? DEFAULT_WORKBUDDY_CLI
  if (!existsSync(cliPath)) return undefined
  const permissionMode =
    env.WEAVE_WORKBUDDY_PERMISSION_MODE ?? env.WORKBUDDY_PERMISSION_MODE ?? DEFAULT_WORKBUDDY_PERMISSION_MODE
  return {
    name: 'workbuddy',
    // CLI 是 node 脚本（shebang）：用宿主同款 node 拉起，避免依赖执行位/解释器路径。
    command: process.execPath,
    args: [cliPath, '--acp', '--permission-mode', permissionMode],
    env: {
      ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(env.WORKBUDDY_ACP_DEBUG === undefined && env.WEAVE_WORKBUDDY_DEBUG === '1' ? { WORKBUDDY_ACP_DEBUG: '1' } : {}),
    },
    // 引擎 fullAccess 自行批准；若引擎仍发权限请求（default 模式），自动选择 allow。
    permission: 'allow',
    // 纯标准 ACP：无 zcode 扩展可协商，扩展面按动态基线降级（可观测，不伪装）。
    declaredExtensions: [],
  }
}
