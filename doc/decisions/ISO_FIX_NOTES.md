# ISO_FIX_NOTES — ACP 会话按 sessionKey 隔离（iso-1）

日期：2026-08-27　基线：2b4422b　范围：`src/plugins/weave/acp/*`、`host-wiring.ts`、两份测试

## 1. 根因与机制分析

**现象**：developer-1 与 frontend-1（不同 sessionKey）混用同一个 zcode 会话（`~/.zcode/v2/acp-lazy-sessions.json` 中仅一条带 `zcodeSid` 的记录），46min 长任务阻塞他人、双超时、上下文互染。

**分层结论**（逐层核实后）：

| 层 | 隔离现状 |
|---|---|
| `DelegationService.executeTask` | sessionKey=`团队:角色:项目:版本`，每角色唯一 ✓（delegation-service.ts `provider.start({sessionKey…})`） |
| `AcpSessionProvider.#sessions`（内存 Map） | 已按 sessionKey 键控 ✓——但**进程内易失**：插件/桥接重启即清空，重启后一切会话走 `conn.newSession` 新建占位符，跨重启续接能力断裂 |
| 桥接 `zcode-acp-server/dist/handlers/session.js#ensureRealSession` | 按 acpSid 别名隔离 ✓（每个占位符独立物化；已带 zcodeSid 的别名直达同一后端会话），但依赖「编辑器侧持续持有同一占位符 id」这一前提 |

**缺失的一环**正是第三层的前提：仓库侧没有任何持久化的 sessionKey→acpSid 映射，进程重启后两个角色各自拿到新占位符、历史记录里旧占位符（含唯一 materialized zcodeSid）无法被定向恢复。本次修复把该前提补上。

## 2. 改法

**核心（acp-session-provider.ts）**：

1. `AcpSessionProviderConfig.sessionIndexFile?: string` —— sessionKey→acpSid 持久索引文件路径；**缺省关闭**（不传时行为与旧版完全一致，纯内存隔离，既有测试零影响）。生产默认路径常量 `DEFAULT_ACP_SESSION_INDEX_FILE = ~/.dsh/weave/acp-session-index.json`。
2. `start()` 会话解析优先级改为三级：
   ```
   weave.resumeSessionId > #sessions 内存表 > 持久索引 readSessionIndexFile()
   ```
   命中索引 → 走既有 `loadSession` 恢复分支（lazy 恢复能力保留：桥接侧 `lookupLazySession(acpSid).zcodeSid` 直达原后端会话，`session.js L167-170`）；未命中 → `newSession` 新占位符（**新任务优先新建**语义不变）。
3. **自愈回退**：索引指向的占位符失效（30 天 TTL 清理 / 记录损坏）时捕获 loadSession 异常，清内存映射并回退新建，随后写索引覆盖失效条目——不会因脏索引导致委托失败。
4. **写穿透**：每次会话确定后（新建、采纳、连接仍识别三种情形）都 merge 写索引（读改写保留其他键；单文件原子重写；IO 全程 try/catch best-effort，绝不阻断委托主链路）。
5. 兼容性：只增改不删任何键；旧的 cwd 维度数据（含 acp-lazy-sessions.json 原文件）零触碰——旧别名通过显式 `resumeSessionId` 路径依旧可达；无索引文件/损坏文件按空表处理。

**接线（iso-1 生效点）**：

- `host-wiring.ts createDefaultExecutorProviderRegistry`：内置 zcode provider 构造时 `{...zcodeConfig, sessionIndexFile: DEFAULT_ACP_SESSION_INDEX_FILE}`。
- `acp/dynamic-provider.ts createAcpProviderFromConfig`：动态 stored provider 同样注入默认路径。
- 两处都指向同一全局索引文件（同机多 provider 共享一份键空间；键本身含团队/角色前缀，无碰撞）。

## 3. 验收证据（验收标准 1→测试）

`__tests__/acp-session-provider.test.ts` 新增 describe「sessionKey 持久索引（iso-1）」，4 用例全绿：

| 用例 | 断言要点 |
|---|---|
| 验收1 隔离 | 两个 sessionKey 各得独立 acpSid（run id 不同）、双双落索引且值正确；同键再次 start 复用原 sid（newSession 总次数不增） |
| 验收2 续接 | 新 provider 实例（模拟重启，内存表为空）+ 同索引文件 → 不调 newSession，改调 `loadSession(sessionId=原sid)`，run id 与首启一致 ⇒ 经桥接别名链复用同一 zcodeSid |
| 边界 自愈 | 索引预置失效别名 + loadSession 必失败 → 自动新建并覆盖索引为新 sid |
| 兼容 缺省 | 未配置索引文件 ⇒ 行为与改动前一致（纯内存、无磁盘副作用） |

门禁：`pnpm typecheck` ✓、`pnpm build` ✓、`pnpm vitest run` **32 文件 / 472 用例全绿**。

## 4. 附带基线修复（非 iso-1 范围，2b4422b 快照遗留，过门禁所必需）

1. `src/client/index.ts` E 块 mock 事件生成器 `kinds[i]` 在 noUncheckedIndexedAccess 下类型错误（`string|undefined` 赋给 `type:string`）→ 索引表达式加 `?? 'status'` 回退。
2. `team-manager.ts importTeam` catch 块引用越界标识符裸 `teamId`（潜伏编译错误）→ 改 `team.team_id`。
3. `client-bundle.ui.test.tsx` 三条 TeamsPage 用例适配模态流：进入页面后先点 `team-new-btn` 再断言字段（对应 REDESIGN_UI_SPEC §2 重构后的交互）；另修正其真实根因——执行器自动补默认 effect 原本只在快照首次到达时运行，模态打开产生的新空白角色不再被兜底 → effect 依赖加入 `editorMode` 且 `openCreate` 直接播种当前首个注册执行器（对用户也是正确行为：打开新建对话框即见默认执行器）。

## 5. 联调注意事项

- **首次升级观察点**：部署本版后首个任务周期内，`~/.dsh/weave/acp-session-index.json` 应出现每个参与角色的键；如某角色任务反复超时，先核对该键的 `acpSid` 是否在 `acp-lazy-sessions.json` 中拥有各自不同的 `zcodeSid`。
- **手工清态**：需要让某角色"换新会话"时，删除索引文件中该 sessionKey 条目即可（下次启动新建占位符并回写）；整文件删除等同全员重建，无需停桥接。
- **多机/换机**：索引文件与 `~/.zcode/v2/acp-lazy-sessions.json` 需成对迁移或成对放弃（只迁前者会把旧别名当失效自愈掉，安全但丢上下文续接）。
- **性能**：每角色首启仍是 newSession 一次 RPC + 首次 prompt 时才物化（lazy 语义未变）；索引读写为本地 JSON 小文件（键数量级 ≤ 团队角色数），无锁竞争面。
- **回滚开关**：两处构造点去掉 `sessionIndexFile` 即回到纯内存旧行为，无需代码分支。
