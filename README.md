# Weave — DSH 多 Agent 团队协作与知识成长框架（Phase 0）

Weave 是部署在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 之上的插件：为 DSH 增加
多 Agent 团队协作（任务编排/状态机/执行器发现）、知识库（导入/审核/注入）与审计能力。
Phase 0 目标为可验证地基：执行器发现、状态机、持久化、知识导入。

设计文档见 `doc/`（功能设计 FDD / 软件设计 SDD / 软件规格 TDD / 架构设计 / 任务规划 / 评审报告）。

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

## 3. 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `pnpm test` | 运行全部测试（`vitest run`） |
| `pnpm test:watch` | 监视模式 |
| `pnpm vitest run src/plugins/weave/__tests__/plugin-loading.test.ts` | 运行单个测试文件（与任务规划 `testCommand` 形态一致） |
| `pnpm build` | 构建 npm 包产物到 `dist/`（`tsc -p tsconfig.build.json`） |
| `pnpm typecheck` | 类型检查（`tsc --noEmit`） |
| `pnpm lint` | ESLint 检查 |

测试路径约定（与 doc/04-任务规划文档.md 的 `testCommand` 对齐）：
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

## 5. 构建说明

- 开发/测试：`tsconfig.json`（bundler 解析 + noEmit），vitest 直接跑 TS 源码。
- 发布：`tsconfig.build.json` 继承开发配置，改为产出 `dist/`（声明文件 + sourcemap），
  排除 `__tests__`；源码对相对导入已使用 `.js` 扩展名（NodeNext ESM 兼容，node>=20 可直接运行）。
- `package.json` 的 `exports`：`"." → dist/plugins/weave/index.(js|d.ts)`（正式包入口），
  `"./src/*" → ./src/*`（开发期源码直载）。

## 6. 与评审第 1 轮（HI-1 / E7）的对应

- E7：仓库无 package.json / src / tsconfig / vitest / eslint → 本脚手架补齐，且 `pnpm vitest run` 已可执行。
- HI-1：DSH 插件交付形态未定义 → 定义为 npm 包 `@deepseek-ai/dsh-plugin-weave`（源码
  `src/plugins/weave/`，产物 `dist/`，cordis 配置方式加载）；任务规划中的
  `pnpm vitest run src/plugins/weave/__tests__/...` 路径与目录布局一致，可直接作为后续任务的前置。
- 冒烟测试：`src/plugins/weave/__tests__/plugin-loading.test.ts` 验证插件可被 cordis 加载。
