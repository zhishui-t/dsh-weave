# AGENTS.md

Weave 仓库的开发与维护指南。先读本文件，再改代码。

## 1. 项目定位

- 包名：`@deepseek-ai/dsh-plugin-weave`
- 形态：DSH（DeepSeek Harness）Web/会话插件
- 目标：多 Agent 团队协作、任务 DAG 调度、知识库与反思、代码图谱、文档转换、Obsidian 同步
- 当前分支约定：核心开发在 `restore/own-team-engine`

## 2. 目录结构

```text
.
├── src/
│   ├── client/
│   │   └── index.ts              # DSH Web 客户端（单文件 bundle，禁止拆散）
│   └── plugins/weave/
│       ├── index.ts              # 插件唯一服务端入口：name/inject/apply
│       ├── acp/                  # ACP/ZCode 会话与动态 provider
│       ├── audit/                # 审计日志
│       ├── convert/              # 文档转换（AnyDoc）
│       ├── core/                 # 运行时组合层：capabilities/executors/team-runtime/on-duty
│       ├── dag/                  # DAG 数据仓库（repository）
│       ├── executors/            # 执行器注册表与 provider
│       ├── graph/                # Graphify 代码图谱与知识图谱服务
│       ├── host/                 # 宿主接线：host-wiring / CLI-MCP / RPC / settings
│       ├── knowledge/            # 知识模型、引擎、审核、反思、导入
│       ├── mcp/                  # MCP 入口
│       ├── obsidian/             # Obsidian Vault 同步
│       ├── persistence/          # SQLite 持久化与单写队列
│       ├── safety/               # 熔断与循环保护
│       ├── scheduling/           # 调度、委托、会话流、状态通知、恢复
│       ├── state/                # 任务状态机与错误类型
│       ├── team/                 # 团队配置、项目级运行时状态、邮箱、迁移
│       ├── ui/                   # 独立 React UI 组件（dashboard / dag-panel）
│       ├── web/                  # Web 查询服务（RPC 后端）
│       └── __tests__/            # Vitest 单元/组件测试（与源码同构）
├── test/
│   ├── e2e/                      # Playwright 测试与 fixtures（harness + live）
│   │   └── acceptance-plan.md
│   └── scripts/                  # 环境检查、E2E 调试、队长任务模拟脚本
├── doc/
│   └── architecture/             # 当前有效设计文档（以这里为准）
├── dist/                         # 构建产物（不提交）
├── .artifacts/                   # 本地调试产物（不提交）
└── .graphify/                    # 根目录图谱输出（仅保留这一份）
```

## 3. 关键约束（不要违反）

1. **`src/client/index.ts` 是单文件 Web 客户端**：DSH 通过 `moduleLoader.load` 加载它，不能引入外部 import。Dashboard、Weave 团队页签、成员卡、DAG 都在这个文件内。
2. **会话团队页签必须存在**：`conversation.view` 槽位注册为 `Weave 团队`，对应 `WeaveSessionPanel`。不要删除或迁移到别处。
3. **服务端入口固定**：`src/plugins/weave/index.ts` 的 `apply(ctx)` 是 Cordis 插件入口；`host/` 负责宿主接线，业务模块不得绕过 `core/team-runtime.ts` 自行组合运行时。
4. **RPC channel 固定**：`/dsh-weave`。RPC handler 位于 `src/plugins/weave/host/rpc.ts`。
5. **团队配置目录**：`~/.dsh/teams/*.yaml`；项目级团队运行态在 `<project>/.dsh/weave/team/`；知识库在 `~/.dsh/knowledge`。
6. **不要提交**：`node_modules/`、`dist/`、`.artifacts/`、`subprojects/`、任何非根目录的 `.graphify/`。

## 4. 常用命令

```bash
pnpm build                 # 编译 src -> dist
pnpm typecheck             # 快速类型检查
pnpm lint                  # ESLint
pnpm test                  # 全部 Vitest 单元/组件测试
pnpm test:ui               # UI 组件测试
pnpm test:e2e:harness      # Playwright harness（stub RPC，不依赖真实 DSH）
WEAVE_E2E_LIVE=1 pnpm test:e2e:live   # 真实 DSH Web E2E
pnpm code:scan             # 生成根目录 .graphify
```

## 5. 开发验证顺序

小步修改，每步验证：

1. 读取相关源码/配置/文档。
2. 改一个模块/文件。
3. `pnpm typecheck`。
4. 运行对应 Vitest 测试：
   ```bash
   pnpm vitest run src/plugins/weave/__tests__/<相关>.test.ts
   ```
5. 涉及 Web 客户端时：`pnpm build`，再运行 harness 或 live E2E。
6. 最后才全量 `pnpm test`。

## 6. 本机环境事实

- Git Bash 若 `sed`/`grep`/`head` 等缺失，先：
  ```bash
  export PATH="/d/code/Git/usr/bin:$PATH"
  ```
- 本地 DSH Web：
  - profile：`web-fork`
  - port：`3080`
  - 重启脚本：`.artifacts/restart-dsh-webfork.ps1`
  - 验证 PID/监听：`.artifacts/diag.ps1`
- Playwright 可用浏览器：
  - Chromium：`C:/Users/10042/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe`
  - Edge：`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`

## 7. 模块职责速查

| 模块 | 职责 |
| --- | --- |
| `team/` | 团队 YAML、绑定、项目运行态、邮箱、迁移 |
| `scheduling/` | DAG 调度、委托执行、会话事件回灌、状态通知 |
| `knowledge/` | 知识存储、审核、反思、导入管线 |
| `host/` | Cordis 宿主接线、`/weave` CLI、MCP 工具、RPC |
| `executors/` | 执行器注册与 provider（zcode/spawn/fork/acp） |
| `graph/` | Graphify 代码图谱、知识图谱 |
| `web/` | 给 RPC 使用的查询服务 |
| `ui/` | 独立 React UI（测试与参考实现） |
| `core/` | 分层运行时组合（勿放业务逻辑） |
| `state/` | 任务状态机、共享类型、WeaveError |
| `persistence/` | SQLite 与 schema |
| `acp/` | ACP 会话、动态 provider、ZCode |
| `audit/`、`safety/`、`convert/`、`obsidian/`、`mcp/` | 各自独立能力 |

## 8. 提交规范

- 小步提交：每完成一个可验证的模块/行为变更就提交。
- 消息用英文或中文短句，说明动机与影响面。
- 提交前确认 `git status` 干净；不要包含 `.artifacts/`、`subprojects/`、非根 `.graphify/`。
