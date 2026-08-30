# Weave — DSH 多 Agent 团队协作与知识成长框架（Phase 0）

Weave 是部署在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 之上的插件：为 DSH 增加
多 Agent 团队协作（任务编排/状态机/执行器发现）、知识库（导入/审核/注入）与审计能力。
Phase 0 目标为可验证地基：执行器发现、状态机、持久化、知识导入。

设计文档见 `doc/`（功能设计 FDD / 软件设计 SDD / 软件规格 TDD / 架构设计 / 任务规划 / 评审报告）。

> **架构迁移状态**：任务/团队核心已切到 `dsh-agent-teams` fork（子模块
> `subprojects/dsh-agent-teams`）。fork 接管后 weave 不再实例化旧任务引擎，
> 并隐藏旧 `weave_plan_tasks / weave_team_* / weave_task_*` 工具与 `/weave team|task`
> CLI；weave 保留知识库、反思、ACP transport、图谱/Obsidian/AnyDoc 等独立能力。

## 1. 工程形态（P0-BOOTSTRAP 定义）

仓库 `weave` 本身即 **DSH 插件 npm 包**：包名 `@deepseek-ai/dsh-plugin-weave`（与 DSH 官方插件
`@deepseek-ai/dsh-*` 命名一致），源码位于 `src/plugins/weave/`，构建产物为 `dist/`。
当前 `"private": true`，Phase 0 不发布；发布时移除并从 `publishConfig.access` 走 public。

```
weave/
├── package.json            # 包元信息、脚本、依赖（cordis 运行时 + vitest/ts/eslint 工具链）
├── tsconfig.json           # 开发/测试用 TS 配置（noEmit，bundler 解析，vitest/编辑器共用）
├── tsconfig.build.json     # 发布构建配置（tsc 产出 dist/，含 .d.ts）
├── vitest.config.ts        # Vitest 配置（node 环境，include src/plugins/weave/__tests__/**）
├── eslint.config.mjs       # ESLint 9 扁平配置（js + typescript-eslint 基础规则）
├── README.md               # 本文件
├── doc/                    # 设计文档（规格来源）
└── src/
    └── plugins/weave/      # 插件源码根（任务规划中所有测试命令的路径前缀）
        ├── index.ts        # cordis 插件入口：{ name, inject, apply } + WeaveService（ctx.weave）
        ├── __tests__/      # Vitest 测试目录（*.test.ts）
        └── persistence/    # P0-DB-004：SQLite 持久化（按任务逐步填充）
```

## 2. 环境与安装

- Node.js >= 20（本地验证：Node 24）；包管理器 pnpm（本地验证：pnpm 11）。
- DSH 基线：`@deepseek-ai/dsh` 0.1.1-rc.2，运行时依赖 `@deepseek-ai/cordis` 4.0.1。
- 基线 DSH 安装（`node_modules`）中**不包含** vitest / typescript / eslint，故本项目自装：

```bash
pnpm install
```

### 依赖来源说明

所有依赖都声明在 **`package.json`** 中，`pnpm install` 会从 npm registry 自动下载到本仓库的
`node_modules/`，**不需要手工单独下载**。本仓库不提交 `node_modules` 与 `dist`，克隆后必须执行
`pnpm install` 才能构建/测试。

| 类型 | 主要依赖 | 说明 |
| --- | --- | --- |
| 运行时依赖 | `@deepseek-ai/cordis`、`yaml`、`zcode-acp-server`、`@firecrawl/anydoc`、`@sentropic/graphify`（代码图谱引擎） | `pnpm install` 自动安装 |
| 开发/测试依赖 | `typescript`、`vitest`、`eslint`、`@playwright/test`、`react`、`jsdom` 等 | 仅开发/测试用，不进入生产运行 |
| DSH 相关 | `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-commands` | 已作为 dev/peer 依赖声明，由 pnpm 安装 |
| 外部宿主 | DeepSeek Harness（DSH）本体 | **需要单独安装/配置**；本仓库是 DSH 插件 |
| 外部执行器 | ZCode CLI | 可通过 `WEAVE_ZCODE_BIN` 指定已安装的 ZCode；未指定时尝试自动探测 |
| 代码图谱 | `@sentropic/graphify` | 已作为项目依赖安装，`node_modules/.bin/graphify` 可直接使用 |

## 3. 常用命令

### 从零构建步骤

```bash
# 1. 准备环境：Node.js >= 20，pnpm
node -v
pnpm -v

# 2. 进入仓库并安装依赖
git clone <仓库地址> weave
cd weave
pnpm install

# 3. 构建产物到 dist/
pnpm build

# 4. 验证
pnpm typecheck
pnpm lint
pnpm test

# 5. （可选）前端控制台/e2e
pnpm build
pnpm test:e2e:harness
```

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `pnpm test` | 运行全部测试（`vitest run`） |
| `pnpm test:watch` | 监视模式 |
| `pnpm vitest run src/plugins/weave/__tests__/plugin-loading.test.ts` | 运行单个测试文件（与任务规划 `testCommand` 形态一致） |
| `pnpm build` | 构建 npm 包产物到 `dist/`（`tsc -p tsconfig.build.json`） |
| `pnpm typecheck` | 类型检查（`tsc --noEmit`） |
| `pnpm lint` | ESLint 检查 |

测试路径约定（与 doc/tasks/04-任务规划文档.md 的 `testCommand` 对齐）：
`pnpm vitest run src/plugins/weave/__tests__/<name>.test.ts`。
Vitest 只收集 `src/plugins/weave/__tests__/**/*.test.ts`（见 `vitest.config.ts`），统一 node 环境。

## 4. 插件加载方式

### 4.1 开发期：源码级 cordis 加载（当前冒烟测试即此方式）

```ts
import { Context } from '@deepseek-ai/cordis'
import * as weavePlugin from './src/plugins/weave/index.js'  // { name: 'dsh-weave', inject, apply }

const ctx = new Context()
await ctx.plugin(weavePlugin as any)   // or: ctx.plugin(weavePlugin) with proper typing
ctx.weave.describe()                   // 服务已注册
ctx.registry.delete(weavePlugin)       // 卸载
```

### 4.2 DSH 正式加载：cordis 配置

与 DSH 现有插件一致（见 `@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml`），
在 cordis 配置文件中以包名声明：

```yaml
- id: dsh-weave
  name: '@deepseek-ai/dsh-plugin-weave'
```

前提：`pnpm build` 产出 `dist/`（包的 `exports`/`main` 指向 `dist/plugins/weave/index.js`），
并把本包安装到 DSH 的依赖树（`pnpm pack` 后安装，或 `pnpm link` 本地调试）。

### 4.3 插件入口契约（cordis 对象插件）

`src/plugins/weave/index.ts` 导出（与 cordis-plugin-loader 兼容）：

- `name` — 插件 identifier `'dsh-weave'`；外部包名 `@deepseek-ai/dsh-plugin-weave`；业务服务以 `ctx.weave` 暴露。
- `inject` — 服务依赖声明；P0 暂无强依赖（`{}`），后续按需声明。
- `apply(ctx, config)` — 注册 `WeaveService`（继承 cordis `Service`，随插件 fiber 自动注册/析构）。

`WeaveService` 在 `ctx.weave` 上提供 `version()` / `describe()` / `loadedAt`，后续模块
（ExecutorRegistry / TaskStateMachine / Persistence 等）以方法或子服务挂载于此。

## 5. 会话即团队：队长模式、会话面板与控制台

**任务下发只有对话一条路，且零仪式**：小队配置好即生效——已有默认团队或
只配了一个团队时，直接说需求就行：

```text
做一个登录页 + 邮箱验证    ← 直接描述目标，队长立刻拆解派发
```

需要多团队切换时才涉及「启用」（自然语言或面板下拉，一次绑定长期生效）：

```text
启用 pipe-team            ← 仅在多个团队且要明确指定时使用
```

解析顺序：会话绑定 > 默认团队 > 唯一团队；全部不满足（无团队配置）时给出
配置指引而非空转。

随后队长模型把目标拆解为「任务列表 + 成员角色 + 依赖」并调用
`weave_plan_tasks` 工具；插件：

1. 校验规划（角色存在、依赖合法且无环），经 SingleWriterQueue 落库
   `dags/tasks/edges` 三表，`session_id` 绑定当前会话；
2. `WeaveScheduler` 按依赖自动调度成员子代理执行（唯一执行出口仍是
   `DelegationService.executeTask` → `ctx.subagents.start`），状态全程回写
   （WAITING/BLOCKED/RUNNING/COMPLETED/FAILED/SKIPPED…14 态矩阵）。
   **一个团队角色同一时刻只执行一个任务**：同角色的后续就绪任务会排队，
   直到该成员空闲；团队 YAML 中的 `max_concurrent_tasks` 不再参与调度仲裁；
3. 每个任务的开始/完成/失败以插件通知回灌当前会话；DAG 结束时发汇总通知，
   队长据此向用户做最终答复。

命令式下发入口已全部移除：MCP `weave_submit_task`、CLI `/weave task submit`、
Web RPC `task/create` 均不存在；保留的 `task status|revise|accept|retry|skip|
cancel|reopen` 是对真实运行中任务的治理动作（取消/重试与实际子代理联动中止/恢复）。

### 队长行为准则（派发后队长模型的值守纪律）

插件在 `weave_plan_tasks` 的工具描述与返回汇总中双通道提示以下纪律，
约束队长模型在派发后的整个回合行为：

1. **在途值守**：有在途任务时队长不得结束会话回合——短周期轮询任务状态
   （`weave_get_status`），定时向用户通报进度，避免用户以为卡死；
2. **高频轮询与及时响应**：值守期间必须高频轮询（15 秒级）并及时响应——任务状态
   一变即向用户通报，用户消息优先处理，禁止长阻塞空等、禁止延迟汇报；
3. **完成即推进**：任务完成后主动读取交付物并推进下一步（下游任务或汇总
   答复），不等用户触发；
4. **失败走治理**：任务失败用 `retry`/`cancel` 等治理动作处理，**不重开计划**；
   任务派发后保持稳定，没有明确触发不变更任务组；
5. **增量追加（禁新建任务组）**：新需求一律用 `weave_plan_tasks` 的 `append_to`
   参数增量追加到当前任务组，编号域内自动递增（如已有 T1/T2 则新任务从 T3 起）；
   **非用户明确要求，禁止新建任务组**；
6. **看配置再派发**：启动团队或团队变更时，先读团队人员配置（roles 全集/能力/
   stages），拆解任务按角色能力匹配；人员使用要均衡，禁止长期只用子集；
   无匹配角色的任务向用户说明而非硬塞；
7. **质量分层**：常规任务由开发自测与测试（tester）覆盖，QA 只做终审收口；
   重大任务块（跨模块/架构级/高风险）可让 QA 提前介入评审；
   **禁止每个任务都派 QA 审核**。

### 会话视图面板（Weave 团队页签）

DSH Web 的每个会话可通过 `conversation.view` 槽位的 **Weave 团队** 页签查看：

- 团队绑定头：本会话绑定的团队，可直接下拉切换或关闭；
- 成员实时状态卡片：每角色显示 空闲 / 执行中（当前任务）/ 最近结果；
- 本会话任务图：按 `session_id` 过滤的最近 DAG 渲染，节点可展开详情并执行
  验收/返工/取消/重试等治理动作。

### 控制台（七页）

DSH Web 左侧底部点击 **Weave** 打开控制台：总览（含修订记录）、团队、知识库、
执行器、审计、设置、使用手册。原「任务中心」「会话管理」两页已移除——任务
治理收敛到会话面板，会话绑定收敛到面板团队头。**任务不由 Web 表单下发。**

控制台中的 **团队** 页面通过 `/dsh-weave` Connection RPC 读取已注册执行器和团队，
并可创建/删除团队配置。角色可选择任意当前真实注册的执行器；ZCode 只是可选源，
不是必需项。

外部 ACP harness 通过当前会话命令接入：

```text
/weave provider add {"name":"myagent","transport":"stdio","command":"node","args":["agent.js"],"protocol":"acp","declaredExtensions":["zcode"]}
/weave provider add [{"name":"agent-a","command":"node","args":["a.js"]},{"name":"agent-b","command":"node","args":["b.js"]}]
/weave provider add {"providers":[{"name":"agent-a","command":"node","args":["a.js"]},{"name":"agent-b","command":"node","args":["b.js"]}]}
/weave provider list
/weave provider remove myagent
```

`provider add` 接受单个 JSON 对象、JSON 数组，或 `{providers|servers|mcpServers:[...]}` / 名字到配置的对象表 形式的 ACP 协议配置；
也接受 YAML、``` 围栏代码块、本地协议文件路径，以及包含 `name/command/args/env/extensions` 等字段的非结构化协议文本（自动尽力提取）。
每条配置的 `transport` 缺省为 `stdio`、`protocol` 缺省为 `acp`；`env` 兼容 `{K:V}` 与 `[{name,value}]`；`extensions` 自动映射为 `declaredExtensions`。
斜杠命令分词器会原样保留 JSON 对象/数组，因此可以直接粘贴含空格的 JSON。

### 从 ACP 协议文档提取 provider 配置

拿到一份新的 ACP 协议/文档时，按下面映射提取：

| 协议文档里的信息 | provider 配置字段 |
| --- | --- |
| 执行器/服务名、`id`、对象 key | `name` |
| 启动命令（stdio 可执行文件） | `command` |
| 启动参数 | `args`（数组或空格/逗号分隔字符串均可） |
| 工作目录 | `cwd` |
| 环境变量 | `env`（对象或 `[{name,value}]` 均可） |
| 文档中声明的扩展能力 | `declaredExtensions`（也可写 `extensions`） |

扩展名判断规则：协议中出现 `session/setModel`、`session/setThoughtLevel`、`session/setMode`、`zcode` 等 ZCode 扩展方法时，填 `zcode`；
如果文档声明了其它扩展（如 `codex`、`claude-code`），把对应扩展名加入数组。
没有扩展时可省略，运行时会对未声明/未探测到的扩展明确降级，不会伪装成功。

常见可直接粘贴的形态：

```yaml
name: my-agent
command: npx
args:
  - my-acp-server
extensions:
  - zcode
```

也可以把上面的 YAML 存成文件后执行：

```text
/weave provider add C:\path\to\acp-protocol.yaml
```

配置持久化到 `~/.dsh/weave/providers.json`，热注册后执行器列表立即可见。

设置页的目录（状态/团队/审计/知识/Obsidian/Provider 配置）可编辑并持久化到 `~/.dsh/weave/settings.json`，保存后下次加载生效。

知识页提供 **Obsidian Vault 入口**（默认 `~/.dsh/obsidian`）：展示真实路径、复制路径，并通过 `obsidian://open` 协议尝试打开；主存储仍是 Markdown + frontmatter，P0 不做双向同步。知识列表下方有**轻量双链图谱**（`knowledge/graph`），基于真实知识文件和 `[[双链]]` 生成节点/缺失目标/关联边；完整 Graphify 查询属于后续版本。
ACP 标准协议由统一内核处理；ZCode 的 model/thought/mode 是内置 extension 示例。
未声明或探测失败的 extension 会以 requested/effective/supported/fallback 明确降级，
不会伪装成功。

内置 ZCode 自动发现仍可选启用：

- `zcode-acp-server` 来自本包依赖；
- ZCode CLI 默认探测 Windows 安装目录，也可用 `WEAVE_ZCODE_BIN` 显式指定；
- 运行 ZCode 的 Node 默认使用当前 Node（需 >=22），也可用 `WEAVE_ZCODE_NODE` 指定。

团队文件写入 `~/.dsh/teams/<team_id>.yaml`；保存前会做完整结构和执行器校验。

## 6. 构建说明

构建只依赖项目内声明的 npm 包，不需要额外下载源码。

### 步骤

```bash
pnpm install      # 安装 package.json 内全部依赖
pnpm build        # tsc -p tsconfig.build.json → 产出 dist/
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm test         # vitest run
```

### 产物与入口

- 开发/测试：`tsconfig.json`（bundler 解析 + noEmit），vitest 直接跑 TS 源码。
- 发布：`tsconfig.build.json` 继承开发配置，改为产出 `dist/`（声明文件 + sourcemap），
  排除 `__tests__`；源码对相对导入已使用 `.js` 扩展名（NodeNext ESM 兼容，node>=20 可直接运行）。
- `package.json` 的 `exports`：`"." → dist/plugins/weave/index.(js|d.ts)`（正式包入口），
  `"./src/*" → ./src/*`（开发期源码直载）。

## 7. 与评审第 1 轮（HI-1 / E7）的对应

- E7：仓库无 package.json / src / tsconfig / vitest / eslint → 本脚手架补齐，且 `pnpm vitest run` 已可执行。
- HI-1：DSH 插件交付形态未定义 → 定义为 npm 包 `@deepseek-ai/dsh-plugin-weave`（源码
  `src/plugins/weave/`，产物 `dist/`，cordis 配置方式加载）；任务规划中的
  `pnpm vitest run src/plugins/weave/__tests__/...` 路径与目录布局一致，可直接作为后续任务的前置。
- 冒烟测试：`src/plugins/weave/__tests__/plugin-loading.test.ts` 验证插件可被 cordis 加载。
