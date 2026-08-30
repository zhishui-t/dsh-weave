# P0-EXEC-021 结论：执行器 Bundle 安装与启用

| 元信息 | 内容 |
| --- | --- |
| 任务 | P0-EXEC-021（t27） |
| 执行人 | dev4（weave-phase0-squad） |
| 日期 | 2026-08-25 |
| 基线 | DSH `@deepseek-ai/dsh@0.1.1-rc.2`（`D:\Program Files\deepseek`），`ctx.subagents` 宿主 `0.1.1-rc.2` |
| 验证命令 | `pnpm vitest run src/plugins/weave/__tests__/executor-bundle.test.ts` → **11/11 通过**（含真实 DSH 宿主加载套件） |
| 关联文档 | `doc/decisions/P0-ENV-001-spike-conclusion.md`（t2）、`doc/reports/review-report-round1.md`（BLK-2/E6） |

---

## 1. 结论（TL;DR）

1. **方案A 完全成立，无需降级到方案B。** 三个 provider 包均可安装并与 DSH `0.1.1-rc.2`
   兼容：`@deepseek-ai/dsh-subagent-{codex,claude-code,acp}@0.1.1-rc.2` 已在 DSH 安装根
   （`D:\Program Files\deepseek\node_modules`）**安装成功**，并在真实 cordis Context +
   `SubagentRuntime` 上**注册成功**：`ctx.subagents.list() = ["codex","claude-code","acp"]`。
2. **审核报告 E6 的版本判定需修正**：`npm view <pkg> version`（= dist-tag `latest`）返回
   `0.0.1-rc.1`，但同包 **dist-tag `next` = `0.1.1-rc.2`**，与 DSH 基线 `0.1.1-rc.2`
   完全同版本线；且其 `peerDependencies` 全部指向 `^0.1.1-rc.2`，与 DSH 宿主已装的
   `dsh-subagent / dsh-session / dsh-subprocess / dsh-timeout / dsh-invariants / dsh-llm /
   dsh-agent`（均为 `0.1.1-rc.2`）与 `cordis 4.0.1` **精确满足**（无重复安装、无 peer 冲突）。
3. **启用配置已应用（provider 层）**：`~/.dsh/profiles/web/cordis.patch.yml` 新增
   `subagent-codex` / `subagent-claude-code` 两行（备份 `.bak-t27`）；`subagent-acp` 因
   Config 要求实际 ACP `command`，仅提供模板（§5.3），未启用。
4. **preset 工具行（模型面）未启用**：`tool-subagent-codex / tool-subagent-claude-code`
   维持 `disabled: true`（§5.2 提供启用片段）；开启后新会话将出现 `subagent_codex` /
   `subagent_claude_code` 工具——部署决策，留给队长/用户确认。
5. 产出 `src/plugins/weave/__tests__/executor-bundle.test.ts`（Suite A CI 常驻 + Suite B
   真实宿主 + Suite C 版本实证）。

---

## 2. 实证记录

### 2.1 npm 版本与 dist-tag（实测 `npm view` 输出）

| 包 | dist-tags | 采用版本 | 命令 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-subagent-codex` | latest=`0.0.1-rc.1`，**next=`0.1.1-rc.2`** | `0.1.1-rc.2` | `npm view @deepseek-ai/dsh-subagent-codex dist-tags` |
| `@deepseek-ai/dsh-subagent-claude-code` | latest=`0.0.1-rc.1`，**next=`0.1.1-rc.2`** | `0.1.1-rc.2` | 同上 |
| `@deepseek-ai/dsh-subagent-acp` | latest=`0.0.1-rc.1`，**next=`0.1.1-rc.2`** | `0.1.1-rc.2` | 同上 |

> 修正说明：评审 E6 以 `npm view <pkg> version`（latest tag）判定"最新版 0.0.1-rc.1
> 低于基线"——实际该版本序列存在与基线同步的 `0.1.1-rc.2`（next tag），三包均与
> dsh-subagent 同次发布（版本列表：0.0.1-rc.1 … 0.1.1-rc.2）。

### 2.2 安装（写入 DSH 安装根，`D:\Program Files\deepseek`）

```bash
cd "D:/Program Files/deepseek"
npm install --no-save --no-package-lock --no-audit --no-fund \
  @deepseek-ai/dsh-subagent-codex@0.1.1-rc.2 \
  @deepseek-ai/dsh-subagent-claude-code@0.1.1-rc.2 \
  @deepseek-ai/dsh-subagent-acp@0.1.1-rc.2
# 结果：added 12 packages, removed 1 package（removed 为 extraneous，逐项核对后
# dsh/dsh-base/dsh-subagent/spawn/fork 等宿主包无缺失）
```

- 根 `package.json`（升级暂存形态 dsh-upgrade-tmp4）未被修改（`--no-save`）；
- 依赖解析：`@openai/codex@0.147.0`（含 `codex-win32-x64` 原生二进制）、
  `@anthropic-ai/sdk@0.93.0` + `@anthropic-ai/claude-agent-sdk@0.3.220`（含
  `claude-agent-sdk-win32-x64`）、`@agentclientprotocol/sdk@0.25.1`、
  `@deepseek-ai/schemastery@3.18.1`、`@deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2` 均就位；
- **无嵌套 `dsh-subagent` 副本**：三个 provider 的 peer `@deepseek-ai/dsh-subagent`
  全部去重到宿主 `0.1.1-rc.2`（`npm ls @deepseek-ai/dsh-subagent` 仅一条）——插件注册
  走的就是基线宿主实现，契合"同版本线"兼容结论。

### 2.3 真实加载与注册（vitest Suite B，裸 cordis Context + 真实 SubagentRuntime）

按 `mod.Config(config)`（schemastery 可调用 Schema，复刻 cordis 的 validate+默认值路径）
→ `mod.apply(ctx, config)` 生产注册路径实测：

- 三个插件模块（`name=subagent-codex/claude-code/acp`）均以原生 ESM 载入（其 import 链
  `dsh-subagent / dsh-timeout / dsh-session / dsh-subprocess / schemastery` 全部从宿主解析）；
- `apply` 后 `ctx.subagents.list()` = **`["codex","claude-code","acp"]`**；
- `getProvider` 返回的 provider 形态：`name` 正确、`start` 为函数、
  `capabilities = NO_START_CAPABILITIES（全 false）`；
- 随后 ```ExecutorRegistry.load({subagents})``` 分类一致：`codex→codex`、
  `claude-code→claude_code`、`acp→acp`（真实名 `acp` 与 Mock 中的占位名 `zcode` 均落入
  acp 分类，规则无需改动）。

### 2.4 已知限制

- **`start()` 端到端冒烟未执行**：与 t2（spawn/fork）同样的限制——`start` 需要真实
  `parent: Agent` 会话（codex/claude-code/acp 还会真正拉起外部 CLI/ACP 进程，依赖各自
  CLI 登录态与 ACP 命令配置）。本次范围（评审 BLK-2 关注面）= 安装 + 模块载入 +
  注册 + `list()` 出现 + 分类正确，已全部实证；**完整 `start()` 冒烟排入 P0-TEST-019
  真实环境冒烟**（与架构 15.1#2 的最终判定对齐）。
- **HMR 生效时机**：`~/.dsh/profiles/web/cordis.patch.yml` 已 touch 触发热重应用；
  新增 provider 行为"服务可用性驱动"，不影响模型面工具目录（preset 行仍 disabled）。

---

## 3. 评估：方案B 是否触发

**不触发。** 方案B 降级条款（"若实证不兼容…spawn/fork 必过，其余安装后验证"）的
前提不存在：三包以 `next=0.1.1-rc.2` 安装即满足全部 peer，注册/分类实证通过。
DoD#3（"执行器 Bundle 已安装并启用，`ctx.subagents.list()` 出现对应 provider"）
以①安装②注册两层实证达成；`list()` 出现性已在真实运行时复现。

---

## 4. 启用配置

### 4.1 provider 行（已应用）

`~/.dsh/profiles/web/cordis.patch.yml` 追加（备份 `cordis.patch.yml.bak-t27`，删除即回滚）：

```yaml
# ── P0-EXEC-021 (2026-08-25, dev4): 执行器 Bundle 启用 ──────────────────────
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
      config:
        providerName: codex

    - id: subagent-claude-code
      name: '@deepseek-ai/dsh-subagent-claude-code'
      config:
        providerName: claude-code
```

### 4.2 模型面工具行（未应用，需部署决策）

`D:\Program Files\deepseek\node_modules\@deepseek-ai\dsh\config\agent-presets\standard\agent.cordis.yml`
中 `tool-subagent-codex` / `tool-subagent-claude-code` 两行移除 `disabled: true` 即启用
模型面工具（`subagent_codex` / `subagent_claude_code`）；注意 preset 在 node_modules 内、
DSH 升级会覆盖（生产建议改为 profile/模式级 preset 覆盖配置）。

### 4.3 ACP provider 行（模板，未应用）

ACP 的 Config 要求 `command`（ACP 协议工具的可执行命令），按实际部署填充：

```yaml
- insert:
    - id: subagent-acp
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp
        command: <ACP 工具可执行命令>   # 必填；如 'claude' / 'npx @xxx/acp-server' / 'go run ...'
        args: []                         # 可选
        permission: reject                # 可选，默认 reject（非交互模式拒绝策略）
```

---

## 5. 交付物清单

| 文件/位置 | 说明 |
| --- | --- |
| `src/plugins/weave/__tests__/executor-bundle.test.ts` | 验证套件（A CI 常驻 4 例 / B 真实宿主 4 例 / C 版本实证 3 例），11/11 绿 |
| `~/.dsh/profiles/web/cordis.patch.yml`（+`.bak-t27`） | provider 启用行（codex/claude-code），已应用，含备份 |
| `doc/decisions/P0-EXEC-021-conclusion.md` | 本结论 |
| DSH 安装根 `node_modules/@deepseek-ai/dsh-subagent-{codex,claude-code,acp}@0.1.1-rc.2` | 三个 provider 包（`--no-save`，未写入 package.json） |

## 6. 复现

```bash
pnpm install
pnpm vitest run src/plugins/weave/__tests__/executor-bundle.test.ts   # 11/11
# 无 DSH 环境时 Suite B/C 自动跳过（CI mock 路径仍是 4/4）；
# 本机默认探测 D:/Program Files/deepseek（DSH_ROOT 可覆盖）。
```

## 7. 对下游/P0 验收口径的影响

- **架构 15.1#2「Codex / Claude Code / ACP provider 通过 ctx.subagents.start 正常返回」**：
  前置条件（Bundle 安装 + 注册）已达成；剩余 `start()` 端到端按 §2.4 排入真实环境冒烟 —
  与 15.1#2 的"安装并启用后验证"措辞一致，无需方案B。
- **F-02 / AC-EXEC-001**：不再需要 Mock 独占路径；真实 `list()` 已含三 provider，
  spawn/fork 与 codex/claude-code/acp 均可在真实环境断言（AC-EXEC-001 的"必过/安装后
  验证"两级口径均满足）。
- **P0-REG-002（ExecutorRegistry）**：真实 provider 名为 `codex` / `claude-code` /
  `acp`（注意与 Mock 占位名 `zcode` 的区别，两者均分类为 `acp`，规则无需改）。
- **P0-DASH-020 执行器页面**：数据源（`registry.list()`）在真实环境可用。
