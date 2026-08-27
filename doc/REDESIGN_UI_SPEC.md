# REDESIGN_UI_SPEC — Weave 控制台重设计规范

| | |
|---|---|
| 版本 | v1.0（设计稿，未落码） |
| 日期 | 2026-08-27 |
| 目标文件 | `src/client/index.ts`（仅此一个 UI 文件；TeamsPage 现为 L734-1319） |
| 范围 | A：团队页配置 CRUD 重做；B：委派超时机制可视化配套设计 |
| 硬约束 | ① 任务/任务图**不进入控制台**——任务只在会话内面板（`WeaveSessionPanel`）展示；② 保持 `weave-page / weave-form / weave-button` 及 `--dsw-*` 既有样式 token；③ 仅写设计不改代码 |

---

## 0. 现状问题清单（重设计依据）

**团队页 TeamsPage（`src/client/index.ts:734-1319`）：**

| # | 问题 | 现状代码位置 |
|---|------|-------------|
| A1 | 创建/编辑共用一张巨型内联表单，每角色 12 字段全部平铺，角色≥2 时页面极长 | L1098-1214，`roleField/roleSelect` 平铺渲染 |
| A2 | 删除用原生 `window.confirm`（`askConfirm`, L453），移动端 webview 中体验差、不可定制、无破坏性视觉警示 | L867-874 |
| A3 | `default: false` 前端写死，用户无法设置默认团队；而服务端选择链「显式 > 绑定 > default > 单一 > 提示」完全依赖该字段 | L831；服务端 `team-manager.ts:441,526` |
| A4 | 三段高级配置 `task_decomposition / knowledge_injection / feedback` 对用户不可见不可改，提交时硬编码默认值 | L833-841 |
| A5 | 无字段级校验与错误文案：team_id 静默 slug 化兜底 `'team'`、maxConcurrent 非法静默回退 1、重复 ID 直接吃服务端报错到顶部 Note | L786-819 |
| A6 | 移动端仅一档 `@media (max-width:900px)` 断点；用户常用手机访问，表单/操作按钮未做触控适配 | L369 |

**会话面板成员卡（B 部分依据，`src/client/index.ts:2477-2672` + `delegation-service.ts`）：**

| # | 现状 |
|---|------|
| B1 | 成员卡只有一行文字（状态标签 + 任务名），运行中成员看不到已运行多久、最近是否有活动在产出 | 
| B2 | 执行器事件流（`delegation-service.ts:420` `#subscribeRunEvents`，事件类型 `status / output / reasoning / tool_call / tool_result`）只在宿主侧流转，聚合后的「最近活动时间」没有回传给 `session/status` |
| B3 | 服务端已有应用层委派超时（`DEFAULT_DELEGATION_TIMEOUT_MS = 300_000`，超时置 `FAILED(errorType='timeout')`，`delegation-service.ts:177,199-200,630-648`），但客户端无任何 timeout 视觉语义；**idle-timeout 为上游新增机制**，契约见 §3.1 |

---

## 1. 通用基线（A/B 共用）

### 1.1 复用的既有 class 与 CSS 变量（禁止新造并行体系）

| 用途 | 复用项 |
|---|---|
| 页面容器 / 表单容器 / 卡片列表 | `.weave-page` `.weave-form` `.weave-panel` `.weave-list-item` `.weave-layout` |
| 字段 / 控件 / 按钮 | `.weave-field`（input/select/textarea 已含统一样式）、`.weave-control`、`.weave-button` + `-secondary/-small` |
| 徽标 / 状态点 / 空态 / 提示条 | `.weave-pill[data-tone]`、`.weave-dot[data-tone]`、`.weave-empty`、`Note({kind:'error'})` |
| 色彩 token | 一律使用 `--dsw-alias-label-* / --dsw-alias-border-l2 / --dsw-alias-bg-layer-2 / --dsw-specific-menu / --dsw-alias-brand-primary`；状态色沿用 `.weave-dot` 四色（run 蓝 #1677ff / good 绿 #52c41a / bad 红 #f5222d / idle 灰 #8c8c8c）；警示琥珀色补一个用法注释即可，值取 DAG 已用的 #faad14 |

### 1.2 新增组件基元（低实现成本，均为 createElement 可写的结构）

| 组件 | 结构 | 说明 |
|---|---|---|
| `Dialog`（含 `ConfirmDialog` 特化） | 遮罩复用 `.weave-overlay`；内容盒新增 `.weave-dialog{width:min(480px,calc(100vw-32px));border-radius:16px;background:var(--dsw-specific-menu);padding:20px;display:grid;gap:12px}` | 替代一切 `window.confirm`；Esc = 取消；点击遮罩 = 取消；打开时焦点落在安全键（取消按钮）；支持 `tone:'danger'` 时确认按钮加红色描边（`border:1px solid #f5222d;color:#f5222d;background:transparent`） |
| `Drawer`（详情抽屉） | 桌面右侧滑入：`.weave-drawer-wrap{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1)} .weave-drawer{position:absolute;top:0;right:0;height:100%;width:min(420px,92vw);background:var(--dsw-specific-menu);overflow-y:auto;padding:20px;display:grid;gap:14px}`；≤600px 见 §2.8 变体 | 只读展示 + 动作入口；Esc 关闭 |
| `Collapse`（折叠分区） | 新增 `.weave-collapse-head{display:flex;align-items:center;gap:8px;cursor:pointer} .weave-collapse-body{display:grid;gap:10px}`；展开态图标 ▸/▾ | 用于高级配置三区与角色卡 |
| `FormField`（带错误态字段） | 在 `.weave-field` 上追加 `data-invalid="true"`（边框转红 `#f5222d`）+ `<span className="weave-field-error">`（红字 11px） | 所有校验错误的统一载体 |
| `Modal`（编辑器容器） | 复用 Dialog 结构但宽版 `.weave-modal{width:min(720px,calc(100vw-32px));max-height:calc(100vh - 48px);overflow-y:auto}` | 承载 TeamFormModal |
| `RelativeTime` | 纯函数 `fmtRel(ms): '刚刚 / N 秒前 / N 分 N 秒前 / N 分前'` | B 部分计时显示共用 |

> **不引入**任何框架组件库；以上都是现有 render 函数风格的延伸，单文件可实现。

### 1.3 data-testid 迁移映射（e2e 不允许静默失败）

e2e 现有依赖（`e2e/harness/console-harness.spec.ts`、`e2e/live/console-live.spec.ts`）必须保留或按下表同步更新：

| 既有 testid | 重设计后 | 备注 |
|---|---|---|
| `page-teams` | **保留** | 页面根 |
| `team-id-input` / `team-name-input` | **保留**（移入编辑 Modal 内） | e2e 改为先点「新建团队」再可见，两份 spec 同步加一次点击 |
| `role-editor-{i}`（内部第一个 select = 执行器） | **保留**（移入 RoleCard 内） | harness/live 都靠它选执行器 |
| `model-select` / `model-select-{i}`（zcode 模型目录） | **保留** | 位置随 RoleCard 迁移 |
| `provider-select-{i}` / `fallback-provider-select-{i}` / `fallback-model-select-{i}` | **保留** | 同上 |
| `team-add-role` | **保留** | |
| `team-create-submit` | **保留**；文案仍需包含「包含 N 个角色」字样（harness:268 断言 containsText） | 编辑模式下该 testid 改为 `team-edit-submit-{id}`，属新增不冲突 |
| `team-detail-{id}` / `team-edit-{id}` | **保留**：detail 改为打开抽屉，edit 打开编辑 Modal | 行为升级、id 不变 |
| `team-delete-{id}` | **保留**为「打开删除弹窗」；弹窗内新增 `confirm-delete-team-danger`（危险确认）与 `confirm-delete-team-cancel` | ⚠️ live spec:216-219「点击后等 detach」需插入一步点击 danger 键 |
| `team-detail-content-{id}` | **改为抽屉根 `team-drawer-{id}`**（旧 id 仅存在于展开卡片内部，无 e2e 引用，可安全更名） | |
| （新增）`team-default-badge-{id}` / `team-set-default-{id}` / `form-default-toggle` / `collapse-{adv|task_decomp|knowledge|feedback}` / `member-meta-{roleId}` | 设计要求的可测锚点 | |
| `weave-session-panel` / `weave-session-team-name` / `weave-session-members` / `member-card-{roleId}` | **保留不动**（B 部分） | member-card 是 B 的验收锚点 |

---

## 2. 设计 A —— 团队页配置 CRUD 重做

### 2.1 信息架构与用户动线

页面保持单层信息架构，把「浏览 → 查看 → 写入 → 危险操作」拆成四类明确模式：

```
团队页 (page-teams)
├── 工具行：标题 + [＋ 新建团队]（主按钮） + 刷新
├── 团队卡片网格（TeamCard × n）
│     · 名称 / 默认徽标 / ID pill / 角色摘要
│     · 卡片动作：详情 | 编辑 | 设为默认(非默认时) | 删除
├── TeamDrawer          ← 点「详情」（只读）
├── TeamFormModal       ← 点「新建团队」(mode=create) 或卡片「编辑」(mode=edit)
│     ├── 基本信息（团队 ID、名称、设为默认开关）
│     ├── 角色 ×n（RoleCard 手风琴）
│     └── 高级配置（三个 Collapse：任务拆解 / 知识注入 / 反馈策略）
└── ConfirmDialog(danger) ← 点「删除」
```

四条核心动线：

1. **新建**：点新建 → 空 Modal（create 模式，ID 由名称自动建议）→ 校验通过保存 → 成功 Note + 列表刷新 → Modal 自动关闭。
2. **查看**：点详情 → 抽屉滑入只读视图 → 关闭（无脏数据，直接关）。
3. **编辑**：点编辑 → 载入团队进 Modal（edit 模式）→ 修改 → 保存覆盖 → 成功提示含「已更新」。edit 模式下若已有改动（dirty）点遮罩/Esc → 弹 ConfirmDialog「放弃修改？」。
4. **删除**：点删除 → danger ConfirmDialog（正文点名团队与后果）→ 点危险确认才执行；成功后关闭一切浮层并刷新。

**默认团队动线**：卡片「设为默认」→ 若存在其他默认团队，ConfirmDialog 说明互斥取代关系 → 保存成功后该卡出现「默认」徽标。编辑器内同一能力是「设为默认团队」勾选框（form-default-toggle），勾选即时提示将被取代的旧默认团队名。

**明确排除**：本页不放任何任务运行数据；任务的运行态只在会话面板（§3）。页面描述文案同步声明这一点。

### 2.2 页面布局

桌面（>900px）：

```
┌──────────────────────────────────────────────────────────┐
│ 团队                                   [＋ 新建团队] [刷新] │
│ Note：加载/成功/错误提示条（既有 Note 组件）                 │
│                                                          │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│ │ 长安   ⟨默认⟩ │ │ 种子团队      │ │ E2E 验收团队  │  ← auto-fit│
│ │ team-id pill │ │             │ │             │    minmax  │
│ │ 3 个角色·概要  │ │             │ │             │   (240px,1fr)│
│ │ 详情 编辑     │ │             │ │             │           │
│ │ 设默认  删除  │ │             │ │             │           │
│ └─────────────┘ └─────────────┘ └─────────────┘           │
└──────────────────────────────────────────────────────────┘
```

- 列表容器从现 `.weave-layout` 双栏（左表单右列表）改为单列卡片网格：`grid-template-columns:repeat(auto-fit,minmax(240px,1fr))`（直接复用 `.weave-grid` 类即可）。表单不再常驻 DOM。
- 卡片头部：名称（b 标签）+ `<Pill label="默认">`（若有）+ ID pill（muted 小字即可，避免双 pill 并排过挤时降级为副标题文本）。
- 卡片主体一行 muted 摘要：`N 个角色 · executor 列表缩略`（如 `coder/zcode · reviewer/spawn`，超出省略号）。
- 动作区两行排版（小屏按钮不被压缩）：第一行 `详情 编辑`（secondary small），第二行 `设为默认(灰) 删除(危险描边 small)`；已是默认的卡不渲染「设为默认」，渲染禁用说明。

详情抽屉（TeamDrawer）内容自上而下：

```
[×]                                    ← 关闭（weave-close 样式）
种子团队  ⟨默认⟩
ID：seed-team · via 说明文案（如"未绑定会话时自动生效"）
──────────────────────────────
角色 coder（ZCode 执行器）            ← 每个角色一小节
  模型 xxx · 思考 high · 模式 build
  阶段：prepare, implement
  并发 1 · 备用 provider/model（有则示）
  提示词全文（personality 段落）
──────────────────────────────
高级配置（读态摘要 3 行，源自 §2.5-C 三段字段）
──────────────────────────────
[编辑团队] [设为默认] [删除…]         ← 底部动作条
```

编辑 Modal（TeamFormModal）骨架：

```
[×] 新建团队 / 正在编辑：seed-team        ← 标题即模式标识
Note(kind=error)：服务端校验错误也落这里
═══ 基本信息 ═══
团队 ID [        ]（自动 slug 建议，失焦生成）  名称 [        ]
[ ] 设为默认团队   ⚠ 将取代当前默认「长安」（勾选时出现）
═══ 角色（N） [＋ 添加角色] ═══
▸ 角色 1 · coder（zcode）              ← RoleCard 收起态一行摘要
  展开态：
  ┌ 基本信息：角色ID 名称 倾向 阶段stages 并发 ┐
  ├ 执行配置：执行器select                     │
  │   └ zcode → ZCode模型目录(model-select) 思考深度 模式
  │   └ 其他 → 推理服务/模型覆盖(provider-select/model-select)
  │   通用：备用推理服务+备用模型(fallback-*)
  └ 人设：personality textarea
═══ 高级配置 ▾（已修改标记 •） ═══          ← Collapse ×3
▸ 任务拆解  ▸ 知识注入  ▸ 反馈策略
──────────────────────────────
[创建团队（包含 N 个角色）/ 保存修改]   ← 粘性底部动作条（≤600px 常驻吸底）
```

### 2.3 组件分解与职责

| 组件 | props / 内部 state | 职责要点 |
|---|---|---|
| `TeamsPage`（重构） | 复用 snapshot resource；state：`drawerId`、`modal: {mode:'create'} \| {mode:'edit', teamId}` 、`deleteTarget: teamId\|null`、`formDraft` | 浮层状态唯一持有者；任一浮层打开时不销毁列表（保滚动位置） |
| `TeamCard` | `team: TeamSummaryRow`、回调×4 | 纯展示 + 动作转发；busy 态由父级传入（删除中禁删） |
| `TeamDrawer` | `teamId`，内部 `useResource(rpc('team/get'))` 取全量 | 列表摘要不够看时拉全量；加载失败给 EmptyState(reason)；ESC/遮罩关闭 |
| `TeamFormModal` | `mode`、`initial?: TeamConfig`（edit 时由 team/get 载入） | 受控表单唯一真源：`draft{teamId,name,isDefault,roles[],advanced{}}`；dirty 跟踪 = JSON 深比较 initial；提交走既有 `useAction`（creator），busy 禁提交钮 |
| `RoleCard` | `index`、`draft: RoleDraft`、executor 目录、capabilities | 手风琴（同屏允许多开，简单实现，不做单开强制）；头部摘要 = `name（executorLabel）`；executor 切换时联动清空/保留模型选择的逻辑**沿用现状**（L1168-1200 分支不变） |
| `AdvancedSection(kind)` | `values`、`onChange` | 三个分区各一套控件（§2.5-C）；收起态右侧显示「默认」或「已修改」muted 标记 + 琥珀点 |
| `ConfirmDialog` | `title/body/tone/cancelText/dangerText/onConfirm/onCancel/busy` | 通用；删除场景 tone=danger |

交互逻辑标注（给实现者）：
- **ID 建议**：create 模式下 name 输入 blur 且 teamId 为空时，按现行 slug 规则（L818-819 同一正则）回填 teamId 并灰字提示「根据名称自动生成」；用户手动改过 teamId 则永不覆盖。
- **保存流程**：本地校验全过 → `rpc('team/import',{overwrite:true,config})` → config 内容 = 现行构建逻辑（L783-843），仅两处变化：`default` 来自 `isDefault` 开关（修复 A3）；三段高级配置来自表单态而非字面量（修复 A4）。
- **设为默认互斥**：前端已知 teams 全量（snapshot）。发现 `otherDefault !== null && isDefault && mode 允许` → 即时 inline 警示；submit 前 ConfirmDialog（仅当默认状态发生变化时触发一次）。**P0 限制**：`team/import` 为整文件写入，取消旧默认需要随后对旧默认团队 read-modify-write 再 import 一次（default:false）；两次调用间失败会产生双默认——UI 在完成后强制 snapshot.refresh，并在两张都带默认徽标时于卡片上警告「检测到多个默认团队，请在其中一个上重新设置」。彻底方案（P1，需后端）见 §4。
- **删除 busy**：删除请求进行中：danger 键转「删除中…」且二次点击无效；同时其他卡的删除钮 disable（沿用 remover.busy 聚合判断）。

### 2.4 状态表

**页面级：**

| 场景 | 呈现 |
|---|---|
| 快照加载中 | Note「正在加载...」+ 网格区域骨架（4 张 `.weave-card` 灰壳，不闪空态） |
| 快照错误 | EmptyState(title『团队列表加载失败』, reason=`${error}，请检查服务连接后点「刷新」`)，网格隐藏 |
| 成功 Note | 操作成功走 Note（绿色不需要，维持中性即可），`creator.note/loader.note/remover.note` 依次取 |
| 团队为空 | EmptyState『暂无可用团队』reason 保留现文案 + 主行动引导「点右上角「＋ 新建团队」开始」 |

**TeamFormModal：**

| 状态 | 呈现 |
|---|---|
| open(create) | 空白 draft，一个默认 RoleCard；光标 autofocus 到名称 |
| open(edit) | 先显示「载入中…」占位（loader.run 包住 team/get），载入失败 → Modal 内 EmptyState + 仅剩「关闭」可用 |
| dirty | 「正在编辑：xxx」旁追加琥珀点 + title 提示；此时 Esc/遮罩/「×」→ ConfirmDialog『放弃修改？未保存的更改将丢失』（确认放弃/继续编辑，焦点在继续编辑） |
| submitting | 提交钮「保存中…」disabled；Cancel 不禁用（可中途关，弹放弃确认） |
| submit 失败 | 错误信息 Note(kind=error) 显示于 Modal 顶部（而非仅页面顶部，用户视线在浮层里）；字段级可映射的错误（如 invalid_team、duplicate id）同时落到对应 FormField |
| submit 成功 | 关闭 Modal + 页面级成功 Note（含团队 ID 与角色数）+ snapshot.refresh |

**ConfirmDialog：** open / confirming(busy，danger 键锁) 两态；focus trap：Tab 循环在两个键之间（简单实现监听 keydown Tab 于对话框根节点）。

**TeamDrawer：** loading（骨架行）/ loaded / error（EmptyState）三态；从「编辑」进入 Modal 时抽屉保持开启被 Modal 盖住（z-index: modal 高一级），保存成功后抽屉用新数据重渲染。

### 2.5 字段表

**A. 团队级（TeamFormModal 顶部）：**

| 字段 | 控件 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| 团队 ID `team_id` | text `team-id-input` | ✔（留空时由名称/`team` 兜底，沿现状） | create：名称 slug 建议 | `[a-z0-9._-]`，输入不合法字符即时预览转换结果；编辑模式锁定（改名=新团队，不允许，灰掉并 tooltip『团队 ID 创建后不可变』） |
| 名称 `name` | text `team-name-input` | ✔ | '' | 留空提交时用 ID 兜底（沿现状 L830） |
| 设为默认 `default` | checkbox `form-default-toggle` | — | false | 勾选出现互斥提示（§2.7 文案 T3/T4） |

**B. 角色级（RoleCard，12 字段分三组）：**

| 组 | 字段 | 控件 | 必填 | 默认值 | 备注 |
|---|---|---|---|---|---|
| 基本 | 角色 ID `id` | text | 建议 | `member`/`member-N`（沿现状构建规则） | 团队内唯一校验 |
| 基本 | 名称 `name` | text | 建议 | 「成员」 | |
| 基本 | 角色倾向 `bias` | text（暂不下拉，catalog 未定义） | 否 | dev | |
| 基本 | 职责标签 `stages` | text（逗号分隔） | 否 | 空 | placeholder 给示例 `prepare, implement` |
| 基本 | 最大并发任务 `maxConcurrent` | number input min=1 step=1 | — | 1 | 非法值阻断提交（不再静默回退） |
| 执行 | 执行器 `executor` | select（executors 注册目录） | ✔ | 第一个注册执行器（沿用 useEffect 补默认 L855-863） | 切换触发下组联动（分支逻辑不变） |
| 执行 | zcode：模型目录 `model` | select `model-select(-i)` | — | 空=继承 | options 缺失时显示「加载能力目录」禁用态（沿现状） |
| 执行 | zcode：思考深度/模式 | select（capability 有则枚举，无则 disabled 说明选项） | — | 空=继承当前会话默认 | 完整沿用 roleAdvancedFields 的 capability 判定（L944-976） |
| 执行 | 非 zcode：推理服务/模型覆盖 | 级联 select `provider-select-i / model-select-i` | — | 空=继承默认 | 级联行为沿现状 L1030-1080 |
| 执行 | 备用推理服务/备用模型 | 级联 select `fallback-provider-select-i / fallback-model-select-i` | — | 不启用 | 级联行为沿现状 L978-1028 |
| 人设 | 角色提示词 `personality` | textarea rows=3 | 否 | 默认人格一句（`DEFAULT_PERSONALITY` L716 保留） | 空时 card 摘要行缀「（默认人格）」 |

> 角色卡片收起态必须让用户不用展开就能看出配置合理性：摘要行 = `name · executorLabel · model||继承 · maxConcurrent×N`。

**C. 高级配置三段（Collapse，默认值 = 现 L833-841 硬编码值，首次展开即所见）：**

| 分区 | 字段 | 控件 | 默认值 | 校验范围 |
|---|---|---|---|---|
| 任务拆解 task_decomposition | `default_difficulty` | select：easy/medium/hard/critical | hard | 枚举 |
| | `dag_templates.{easy,medium,hard,critical}` | text×4（逗号分隔阶段序列） | 均为 `prepare, implement, review` | 每个模板 ≥1 个非空阶段 |
| | `matchers` | 只读提示行：「匹配规则暂不支持在此编辑，将保持为空」 | `[]` | 不提供编辑（数组 schema 复杂，成本划入 P1） |
| 知识注入 knowledge_injection | `max_entries` | number | 3 | 整数 0–20 |
| | `max_chars_per_entry` | number | 2000 | 整数 ≥100 |
| | `max_total_chars` | number | 6000 | 整数 ≥ 单条上限（校验器给出「应 ≥ 单条上限」的字段错） |
| | `priority` | select：freshness_first（现行唯一合法值，未来扩枚举只改常量表） | freshness_first | 枚举 |
| 反馈策略 feedback | `feedback_timeout_seconds` | number（秒） | 1800 | 整数 ≥60 |
| | `max_revisions` | number | 2 | 整数 0–10 |
| | `reopen_window_seconds` | number（秒） | 86400 | 整数 ≥0 |

辅助阅读：每个 number 控件下方放一行 11px muted 单位说明（如「秒」「条数」），避免纯数字含义不明。

### 2.6 校验规则与触发时机

| 规则 | 触发时机 | 错误文案（FormField error 位） |
|---|---|---|
| `name` 非空 | blur + submit | 『请填写团队名称』 |
| `team_id` 字符集/长度（≤64） | 输入实时（红线+预览）、submit 阻断 | 『只能使用小写字母、数字和 . _ -』／『长度不能超过 64』 |
| `team_id` 与既有团队重复 | 输入实时比对 snapshot | 『已存在同名团队 ID：xxx』（edit 模式排除自身） |
| `roles.length ≥ 1` | submit | 提交钮天然保证；最后一张卡不可删（沿现状） |
| 角色 `id` 唯一（团队内） | 该字段 blur + submit | 『角色 ID 在团队内需唯一，与「yyy」冲突』 |
| `max_concurrent_tasks` ≥1 整数 | blur + submit | 『需为不小于 1 的整数』 |
| dag_templates 各模板非空 | submit（仅当该 Collapse 曾展开/修改） | 『至少需要一个阶段，如 prepare, implement, review』 |
| 数值区间越界 | blur + submit | 统一格式『应在 X–Y 之间』『不能小于总长上限』 |
| 服务端错误（invalid_team 等） | submit 后映射 | 优先映射到字段；映射不到 → Modal 顶部 error Note |
| personality 为空 | 不阻断 | 收起时摘要注「（默认人格）」，软提示不做成 error |

校验原则：**submit 时所有 error 全量列出并滚动到首个错误字段**；blur 校验只对用户实际碰过的字段生效，避免开箱即报错。

### 2.7 文案表

| ID | 场景 | 文案 |
|---|---|---|
| T1 | Modal 标题（create/edit） | 「新建团队」／「正在编辑：{name}」 |
| T2 | 提交按钮 | 「创建团队（包含 {n} 个角色）」／「保存修改（包含 {n} 个角色）」（harness 断言子串得以满足） |
| T3 | 勾选默认时 inline 提示 | 「设为默认后，未绑定会话将自动启用本团队（现默认：{otherName}，保存后将取消其默认标记）」；无 otherDefault 时：「设为默认后，未绑定会话将自动启用本团队」 |
| T4 | 卡片「设为默认」确认弹窗 | 标题『设为默认团队』正文「将取消「{otherName}」的默认标记，未绑定的会话此后自动启用「{name}」。」确认键「设为默认」 |
| T5 | 删除弹窗 | 标题『删除团队』；body：「即将删除团队「{name}」（{id}）。其 YAML 配置文件会被一并移除，且**不可恢复**。」次行 muted：「如有会话绑定本团队，这些会话将在下次解析时回落到默认团队或提示重新选择。」 |
| T6 | 删除确认键 | 「确认删除」（danger 描边） |
| T7 | 编辑弃改确认 | 『放弃修改？』body「未保存的更改将丢失。」键：「继续编辑」（安全默认焦点）／「放弃修改」 |
| T8 | 默认徽标 | pill 文本「默认」，tooltip「未绑定会话自动启用本团队」 |
| T9 | drawer 高级配置读态 | 三行键值摘要，例：「任务拆解：默认难度 hard · 模板 prepare→implement→review」 |
| T10 | 成功提示 | 「已保存：{id}（{n} 个角色）」／「已更新：{id}」／「已删除：{id}」／「已设为默认：{id}」 |

### 2.8 移动端断点规范

断点体系（现状 900px 单档 → 三档）：

| 断点 | 适用 | 布局与交互差异 |
|---|---|---|
| >900px | 桌面 | §2.2 标准布局；Modal/Drawer 居右/居中，宽 480/720px |
| ≤900px | 大手机/小平板 | 维持现状单列；卡片网格回落单列（auto-fit 天然达成）；Modal 宽 `calc(100vw - 32px)` |
| ≤600px | 手机（主力场景） | ① Drawer 变**底部全屏 sheet**（`inset:auto 0 0 0; height:94vh; border-radius:16px 16px 0 0`，下滑手势不做、右上角关闭即可）；② Modal 变近全屏（`height:calc(100vh - 32px); margin-top:16px`），底部动作条 `position:sticky; bottom:0; background:var(--dsw-specific-menu); border-top:1px solid var(--dsw-alias-border-l2); padding:10px 0` 吸底；③ `weave-role-grid` 双列改单列（media 覆盖 `grid-template-columns:1fr`）；④ 控件触控目标：`.weave-field input/select/textarea` 与 `.weave-button-small` 在 ≤600px 下 min-height 提到 40px/32px；⑤ 卡片动作两行排布保证 ≥44px 点击高度；⑥ 对话框 ConfirmDialog 全宽居中、键纵向堆叠（取消在上） |

新增 media 查询统一追加到 `ensureStyle()` 样式串尾部（单文件注入方式不变）：
```css
@media (max-width:600px){ .weave-role-grid{grid-template-columns:1fr}
  .weave-field input,.weave-field select,.weave-field textarea,.weave-control{min-height:40px}
  .weave-sheet{...} .weave-dialog-actions{flex-direction:column-reverse} }
```

Shell 层备注（影响手机的真因）：控制台跑在宿主 `.weave-shell` overlay（216px 固定侧栏）里。≤600px 时侧栏挤压内容 —— 本期 P0 允许接受横向滚动，将「侧栏收起为顶部横滚导航」列为 P1 整壳改造（涉及 index 以外布局面），在验收标准中不含此项。

### 2.9 可访问性与容错要点

- 浮层打开时 `document.activeElement` 记录、关闭后归还焦点；Esc 关闭；背景滚动锁定（overlay 处 `overflow:hidden`）。
- ConfirmDialog 危险操作默认焦点在**取消**；普通确认默认焦点在确认。
- 徽标/状态类信息配 tooltip title（pill 已支持）；颜色不作为唯一区分——默认徽标带文字「默认」，idle-timeout 带「空闲超时中断」文字（§3）。
- 删除流程防误触双保险：danger 键确认 + 弹窗期间其余删除钮禁用。

### 2.10 验收标准（A）

1. 打开团队页只见列表，无常驻表单；「＋ 新建团队」/卡片「编辑」分别以 create/edit 模式打开 Modal，标题、提交按钮文案符合 T1/T2。
2. 12 个角色字段按分组呈现且默认只展开第 1 张 RoleCard；添加第 2 角色不显著延长首屏（手风琴收起态单行）。
3. 新建成功后列表出现新团队卡；再次打开编辑同一团队，各字段（含 zcode 模型、思考深度、备用模型、高级配置）完整回显。
4. `team-create-submit` 提交 payload 中 `default` 等于表单开关；勾选后在另一张卡上观察到原默认团队的「默认」徽标消失或出现「多个默认团队」警示（取决于双默认是否发生）。
5. 勾选「设为默认团队」且存在旧默认时，T3 文案与 ConfirmDialog 顺序出现；取消勾选可直接保存（允许零默认状态）。
6. 三段高级配置初始值与 §2.5-C 表一致；修改 `feedback_timeout_seconds` 为 59 → 提交被拦截并显示区间错误。
7. team_id 输入 `My Team!` → 实时显示 slug 预览 `my-team`；与他人团队重名 → 字段红 + T 表文案，提交阻断。
8. 点「删除」弹出 danger ConfirmDialog；点遮罩/Esc/取消均不删；点「确认删除」后该卡消失，返回成功 Note；live e2e 更新后可通过。
9. 编辑过程中产生 dirty 后按 Esc 出现放弃确认；选「继续编辑」内容保留。
10. ≤600px 视口：RoleCard 内字段单列、Modal 吸底动作条、Drawer 为底部 sheet、所有按钮可正常点击（无 <40px 死区）。
11. 全部 §1.3 「保留」testid 在新 DOM 中仍可定位（命名不变，位置迁移），Harness/Live e2e 按 §1.3 修正后绿。

---

## 3. 设计 B —— 委派超时机制可视化（会话面板）

### 3.1 数据契约（与上游 delegation 机制的对齐点）

执行器事件流事实（`delegation-service.ts`）：`#subscribeRunEvents` 通过 `run.onEvent` 订阅，事件类型 `ExecutorRunEventType = 'status' | 'output' | 'reasoning' | 'tool_call' | 'tool_result'`（L240），经 `#emitExecutorEvent` 向观察者分发（token 流=text 型 output/reasoning 事件，工具流=tool_call/tool_result，生命周期=status）。服务端另有应用层竞速超时：到期 `#finishExecutorRun(run.id,'timeout','Weave 委托超时…')` 且结果映射 `errorType='timeout'/status='FAILED'`。

可视化所需的最小新增字段（约定为本设计的消费契约，供上游会话面板任务落地；本设计只规定显示，不规定其产生方式）：

| 字段 | 位置 | 类型 | 语义 |
|---|---|---|---|
| `last_event_at` | `session/status` → members[i] | ISO 时间字符串 | 该成员最近一次执行器事件（任意 type，token/tool/status 中以 **output/reasoning/tool_call/tool_result 为准，status 不刷新活动时间**）的时间戳 |
| `current_tool` | members[i] | string | 最近一次 `tool_call` 的工具名（未闭合即视为进行中；收到对应 result 后保留至下一 call） |
| `interrupt_reason` | task/get / task/list 行 | `'idle_timeout' \| ...` | 任务被**空闲超时**打断的原因标记；配合任务 status 落在 `INTERRUPTED`（沿用 14 态矩阵，不新增状态值） |

> 区分两类超时的语义必须在 UI 明示：**委派总时长超时**（=「执行超时」，整次运行超过上限）与 **空闲超时**（=「长时间无输出被中止」，`interrupt_reason='idle_timeout'`）。两者都表现为任务中断，但对用户的含义不同（后者常意味着模型挂起/僵死，重试通常有效）。

### 3.2 成员卡信息层级（SessionStatusMember 渲染增强）

卡片保持既有结构（名称行 + 状态行），**新增第三行 meta**（仅 running 或异常时有内容）：

```
┌──────────────────────────────┐
│ ● coder（ZCode 执行器）        │  ← b 行（不动）
│ ◉ 执行中 ·「接入支付渠道」      │  ← 状态行（不动，tone=run）
│ 已运行 12 分 30 秒 · 活动 5 秒前 │  ← 新增 meta 行（weave-member-meta）
│ ─ 最新工具 Read               │  ← current_tool 存在时并入上一行末尾
└──────────────────────────────┘
```

三种形态的字段映射：

| 成员形态 | meta 行内容 | 视觉 |
|---|---|---|
| `status='running'`（有 `started_at`） | `已运行 {fmtDur(now-started_at)}` + 「 · 」+ `活动 {fmtRel(now-last_event_at)}`；`current_tool` 非空再接 ` · 工具 {label}`（过长截断 title 全名） | 常规 muted；`now-last_event_at` > 静止阈值（60s，且 < idle 上限可推算时用剩余时间制）→ 「活动 N 秒前」片段转琥珀 #faad14，暗示停滞 |
| `status='running'` 但 `started_at` 缺失 | 「已运行时长未知」降级文案（防御后端老数据） | muted |
| 上一任务被打断（`last_status='INTERRUPTED'` 且 `last_interrupt_reason='idle_timeout'`※） | `空闲 · 上次被空闲超时中断：「{last_subject}」` | 状态点仍灰，meta 片段「空闲超时中断」转 bad 红 |

※ members 行同样透出 last 任务的 `interrupt_reason`（`last_interrupt_reason`），若无此字段则以 task 列表反查兜底；设计中两处字段都写入契约，避免实现者漏掉成员卡这条路径。

时间计算规则：
- `fmtDur(s)`：<60s → `{s} 秒`；<3600 → `{m} 分 {ss} 秒`（秒保留两位数字）；≥1h → `{h} 小时 {m} 分`。
- `fmtRel(s)`：<10s → 「刚刚」；<60 → 「{s} 秒前」；<3600 → 「{m} 分前」。
- **时钟偏移防护**：`last_event_at` 早于 `started_at` 或晚于本地 now+5s 时视为脏数据，隐藏该片段时间而不报错（浮层内不许出现 NaN/负数）。
- 计时平滑：数据源仍是 5s 轮询（`SESSION_REFRESH_MS` 不动）；客户端在成员卡层用一个 1s interval tick 只重算显示（不新增 RPC）。组件卸载/会话切换清理 timer。

### 3.3 任务图节点的 idle-timeout 呈现

被空闲超时打断的任务出现在本会话任务图（`weave-dag-node`）与节点详情区：

| 位置 | 规则 |
|---|---|
| 节点第二行（状态文字处，现 `TASK_STATUS_LABELS` 映射） | status=INTERRUPTED 且 interrupt_reason='idle_timeout' → 显示「已中断 · 空闲超时」，title 补全解释；其余 INTERRUPTED 维持「已中断」 |
| 节点左边框色 | 沿用 `DAG_STATUS_COLORS.INTERRUPTED` 现值，不为此新增色 |
| 会话面板成员卡上文/详情抽屉（选中该节点） | 语义解释块：标题「已被空闲超时中断」，正文 = V6 文案（§3.5），动作区保留矩阵既有的「重试 / 取消」（`TASK_ACTIONS_BY_STATUS.INTERRUPTED` 不动） |
| 客户端标签表变更 | **不新增状态枚举**——沿用 `TASK_STATUS_LABELS.INTERRUPTED='已中断'`，超时语义由 reason 拼接展示；服务端 14 态合法性矩阵零改动 |

### 3.4 状态表（B）

| 场景 | 呈现 |
|---|---|
| `last_event_at` 缺失（上游未上线/老快照） | meta 行整体不渲染，卡片回到现状——**向后兼容，不显示破图** |
| running 且活动 <60s | 正常蓝点 + 计时行 |
| running 且活动 60s–超时阈值 | 计时行照常，「活动 N 分前」琥珀色；不额外报警音/闪烁（移动端省电） |
| 成员被 idle-timeout 打断瞬间 | 下一次轮询内（≤5s）：状态点变灰、meta 行红字标注原因；**不打断用户当前滚动态，不弹窗** |
| 成员长时间 running（≥ 委派总超时窗口附近） | 「已运行」数值不变 amber 提示（预告可能总超时），上限兜底以服务端裁决为准，UI 不自行判死 |
| 相对时间超过 60 分钟仍 running | 显示「已运行 1 小时 3 分」并附 title「如果长时间无响应，可尝试取消后重试」 |

### 3.5 文案表（B）

| ID | 场景 | 文案 |
|---|---|---|
| V1 | running meta | `已运行 {dur} · 活动 {rel}`(+` · 工具 {tool}`) |
| V2 | 活动停滞 | 同 V1，但 rel 片段着琥珀；title=「超过 1 分钟未检测到模型输出或工具活动，可能在等待慢速响应」 |
| V3 | started_at 缺失 | 「已运行时长未知」 |
| V4 | 成员卡 idle-timeout | `空闲 · 上次被空闲超时中断：「{subject}」` |
| V5 | DAG 节点 | `已中断 · 空闲超时` |
| V6 | 任务详情解释 | 标题「已被空闲超时中断」正文「该成员长时间没有任何模型输出或工具活动，系统按空闲超时策略中止了本次执行。这类中断通常是临时性的，可直接「重试」。」 |
| V7 | 总超时（对照语义，用于 status='timeout' 的完成事件 toast/Note） | 「执行超时（总时长达到上限）」 |

### 3.6 边界情况

- 多事件高速流下 `last_event_at` 每 250ms 可能刷新多次（readOutput 轮询路径）：聚合取 max 即可，前端不做历史。
- 并发修订（REVISION_RUNNING）成员同样套用 §3.2 running 形态（`started_at` 以修订启动时间为准——若上游只给原任务起始时间，差值偏大是可接受的近似，不做第二次换算）。
- 手机窄屏：meta 行允许折行成两行（`flex-wrap`），「已运行」「活动」两段各自成组不截断。
- 会话切换：timer/资源依赖 `sid` 重建（现有 effect 模式），杜绝跨会话串数据。

### 3.7 验收标准（B）

1. 上游注入 `last_event_at/current_tool` 后：running 成员卡出现「已运行 … · 活动 …（· 工具 …）」，秒级跳动（间隔约 1–2s 可感知递增）。
2. 人为制造 60s 无事件（mock 或暂停 executor）：卡片「活动」片段转琥珀色，无其他 disruptive 行为。
3. idle-timeout 打断一次任务后 ≤5s：对应任务节点显示「已中断 · 空闲超时」，成员卡回到 idle 且 meta 行含 V4 文案，任务详情含 V6 解释与「重试」入口。
4. 普通 FAILED/人工取消的任务**不**出现「空闲超时」字样（reason 缺失时严格回落通用文案）。
5. 去掉 mock 注入（老协议）：三张成员卡回到当前线上一致表现，无多余空行/undefined 文本。
6. `member-card-{roleId}`、`weave-session-members` 等 testid 不变；harness e2e 对「空闲」containsText 断言继续成立（V4 文案以「空闲 · 」开头，满足成员 reviewer 现有断言）。

---

## 4. 实施分期建议

| 期 | 内容 | 理由 |
|---|---|---|
| P0 | A 全部 §2 内容 + B 的成员卡 meta 行/相对时间/idle-timeout 文案 + e2e 迁移 | 均为纯前端 + 既有 RPC 可达（除 §3.1 契约字段缺失时优雅降级） |
| P1 | `team/set-default` 后端原子互斥（消除双默认竞态）；高级配置 matchers 编辑器；shell ≤600px 导航收纳；委派总超时的进度环预估（需推送型通道，当前 5s 轮询没必要） | 依赖后端/上游排期，UI 层先留位（警示文案已内建） |

---

# 评审记录（质量审核 · 2026-08-27）

**结论：有条件通过。** C1–C3 为进入实现前必须修订的设计缺陷（均为文档修订，工作量小）；C4 为建议级。修订后无需再次评审，由队长确认修订落盘即可放行。

审核依据的代码事实（均已核实）：
- `team/import` config 路径 `stringifyYaml(input.config)` 整文件重建（`rpc.ts:229-236`）；`overwrite:false` 且文件已存在 → `WeaveError('conflict')`（`team-manager.ts:373-375`）；写入保留的是入参 raw/config，**原 YAML 注释必丢**。
- `team/get` → `serializeTeam(loadTeam())` 返回**全量**：含 `task_decomposition / knowledge_injection / feedback / executor_limits`（`rpc.ts:126-151`）。
- `changan.yaml`（`~/.dsh/teams/`）真实值：matchers 4 条、dag_templates 四档分级、knowledge 5/500/2500、feedback.max_revisions 5、executor_limits.zcode.max_concurrent **2**、default true。
- `validateTeam` 规则（`team-manager.ts:247-318`）：角色 id 唯一、max_concurrent>0、可选字段「配置即非空」、fallback 成对、执行器须注册（`executor_unavailable`）、matchers 正则合法、default_difficulty 枚举且对应模板必须存在、executor_limits 数值>0。**服务端无跨文件 default 唯一性强制**。
- `host-wiring.toJsonPropertySpec` 参数外壳修复在位（`host-wiring.ts:111,124,298`），本设计为纯 `client/index.ts` 前端改动，不触碰该路径，无回退风险。
- `#awaitResultWithTimeout` 为固定墙钟 Promise.race（`delegation-service.ts:768-776`），超时后 `run.dispose()`（L639-648）；`#subscribeRunEvents` 三路：`onEvent` 直通 / `readOutput` 250ms 快照轮询 / `session/event` 转换；无订阅能力时只发一条 `status:'stream_unavailable'`（L476-484）。**现状不存在空闲检测**，设计将其定位为上游新增契约正确。

## 意见明细

### 【C1 · 阻塞】§2.3 / §2.5-C —— 编辑保存会用默认值摧毁既有 YAML 高级配置

设计规定「config 内容 = 现行构建逻辑（L783-843），仅两处变化」，并写明 matchers「将保持为空」；字段表完全缺失 `executor_limits`。按此实现，编辑 `changan.yaml` 保存（`overwrite:true`）将发生：matchers 4 条 → `[]`；dag_templates 四档分级 → 统一 `prepare,implement,review`；knowledge 5/500/2500 → 3/2000/6000；max_revisions 5 → 2；executor_limits.zcode.max_concurrent 2 → 1（自动生成恒为 1/20）；YAML 注释全丢。前四项因表单回显可救，后三项（matchers、executor_limits、注释）按现稿必然丢失。

**改法（文档修订）**：在 §2.3 保存流程增加一条铁律——**edit 模式 initial 必须取 `team/get` 全量返回（数据已可达，见 rpc.ts:146-149），提交 config = 全量 initial 的深拷贝 + 用户显式修改的字段覆盖；表单未覆盖的字段（matchers、executor_limits、以及用户未展开修改的三段子项）一律原样回传，禁止任何「重建默认值」路径**。§2.5-C 的 matchers 文案改为「保持团队原配置不变（P1 提供编辑器）」；补一行 executor_limits 说明「编辑模式原样保留，新建模式沿用现行自动生成」。§2.4 增加：edit 保存确认弹窗提示「保存将以表单内容重写 YAML，文件内的注释将丢失」。验收标准 §2.10 追加第 12 条：编辑 changan 类团队保存后 `~/.dsh/teams/{id}.yaml` 的 matchers/executor_limits 与原文件一致。

### 【C2 · 阻塞】§3.1 —— 空闲超时契约缺三条硬约束，按现稿上游无法安全实现

1. **无事件源执行器回退缺失**：`delegation-service.ts:476-484` 的 `stream_unavailable` 路径整段运行无任何 token/tool 事件，而契约恰好规定「status 不刷新活动时间」——两者组合会把这类执行器在 idle 阈值到达时**误杀**。契约需补：收到 `status:'stream_unavailable'` 的运行**豁免 idle 检测**（仅受总时长墙钟约束），或该场景以 status 兜底刷新活动时间。`readOutput` 250ms 快照轮询路径有事件，不受影响。
2. **事件风暴防抖缺失**：token 流 text-delta 可达每秒数十条；若每个事件都更新聚合端 `last_event_at` 并触发观察者/序列化，是写放大。设计 §3.6 只解决了前端显示端取 max。契约需补：聚合端对 `last_event_at` 更新做**节流合并（≥1s 粒度）**，仅保证单调不减。
3. **绝对上限缺省**：现状墙钟是不被事件重置的固定 setTimeout。若上游实现 idle 时以「事件重置计时器」替换墙钟，慢滴流运行（每 59s 吐一个 token）永不终止。契约需补：**idle 计时与总时长绝对上限并存、互不取消，任一先到即触发**；总上限缺省值沿用 `DEFAULT_DELEGATION_TIMEOUT_MS`（300s）或独立可配，但必须有。V7 文案（总超时）的显示语义也依赖此条。

另：§3.1 需补 `last_event_at` 的初始化定义（running 且尚无事件时取 `started_at`），避免实现各自猜测。

### 【C3 · 阻塞】§2 全篇 —— 未覆盖「同 team_id 在别处被修改」的并发冲突

口径明确要求，现稿只有 default 唯一性处理（该部分合格：双默认警示 + P1 原子化方案成立，因服务端确实无互斥）。并发冲突现行为静默 last-write-wins：编辑 Modal 打开期间他处保存了同 ID 团队，本端保存直接整文件覆盖，无任何提示。**改法（二选一，写入 §2.3）**：轻量乐观锁——edit submit 前重新 `team/get` 比对内容哈希，不一致则弹 ConfirmDialog「团队已被其他窗口修改：覆盖 / 重新载入」；或至少在保存确认弹窗中明示覆盖语义。推荐前者，纯前端可达。

### 【C4 · 建议】不阻塞，实现阶段随手落实

| # | 位置 | 问题与建议 |
|---|---|---|
| C4.1 | §1.2 / §2.9 | Dialog/Drawer 补 `role="dialog"` `aria-modal="true"` `aria-label`；成员卡计时行每秒变化，应 `aria-hidden` 或提供低频 `aria-live="polite"` 摘要，避免读屏骚扰 |
| C4.2 | §3.2 | 「活动 60s 转琥珀」阈值硬编码；若上游 idle 上限可配且 <60s，展示滞后于实际中断。建议阈值从契约字段获取，或在 §3.1 标注「假定 idle 阈值 ≥60s」 |
| C4.3 | §2.6 | 补前端校验：无模型目录时的 fallback 手填分支（现状 L978-983）需「成对填写」检查，否则吃服务端 `fallback_provider 与 fallback_model 必须成对配置` 报错（映射虽能兜底，但体验差） |
| C4.4 | §2.4 | edit 载入失败场景补点：执行器掉注册时 `loadTeam` 抛 `executor_unavailable`，且 `listTeams` 会把该团队整体过滤出列表（team-manager.ts:353-357）——Modal 根本打不开。建议载入失败 EmptyState 文案点明「该团队因执行器未注册而暂不可用/不可编辑」，给用户归因 |
| C4.5 | §2.5-C | knowledge_injection「max_total_chars ≥ 单条上限」的校验方向写对了，但未覆盖「3 × 500 ≤ 2500」式的一致性提示；可选，不影响正确性 |

## 逐口径核验摘要

| 口径 | 结论 |
|---|---|
| 1) CRUD 五动线 + 异常分支 | 动线闭环 ✓（create/read/update/delete/set-default 均有状态表）；异常分支大体完备；**并发冲突缺 → C3**；default 唯一性处理合格 ✓ |
| 2) 技术约束一致 | schema 样例（examples/team.yaml + changan.yaml）比对完成；`overwrite` 语义理解正确 ✓；validateTeam 规则与前端校验映射基本齐 ✓；`toJsonPropertySpec` 修复在位且本设计无触碰 ✓；**但 edit 回传策略与 changan.yaml 实际内容冲突 → C1** |
| 3) 移动端/可访问性可验收 | 断点三档、触控目标 px、sticky 动作条均可验收 ✓；可访问性缺 aria 细节 → C4.1 |
| 4) 空闲超时可行性 | 定位正确（idle 为新增、事件流已具备、readOutput 轮询可用）✓；三类遗漏（无事件源回退/风暴防抖/绝对上限）→ C2 |
| 5) 成本标注 | 基元 createElement 化、matchers 划 P1、P0/P1 分期合理 ✓；yaml 注释丢失成本未标注 → 并入 C1 |

— 评审完，等待 C1–C3 修订后放行 —


---

## 队长附言（B0 插入需求：执行器运行可视化，2026-08-27）

> 本节由队长在 QA 评审期间补入，请与正文一并评审；实现归入 u3 第 E 块，终审由 u5 覆盖。

### 背景（实证）
- DSH 原生 spawn/fork 子代理可见可点：它们是宿主会话树子节点（useSessions 读 subagentsByParent，openSubagent 打开 transcript）。
- weave 的 zcode 执行器是外部 ACP 进程，不进宿主会话树 ⇒ 控制台/会话面板均看不到运行实例也无法点入。
- DelegationService.#subscribeRunEvents 已抓取实时事件并缓存于 #executorRuns（每 run 上限 200 条），但 getExecutorRun 无任何调用方——缓冲数据无出口。
- 权威原始输出：~/.zcode/cli/rollout/model-io-<sid>.jsonl（逐请求落盘）。

### E 块需求：执行器运行浏览器（会话面板）
1. **新 RPC `executor/run-events`**：入参 taskId 或 runId；出参 ExecutorRunSnapshot（sessionId/status/events 尾部 N 条，N 可选默认 50）。注意内存缓冲随终态清理的时机——completed/failed 后快照应延迟清理或落 tasks.db result 侧车，保证事后可追溯。
2. **成员卡交互**：运行中成员卡新增「查看输出」展开区——轮询上述端点（≥1s 间隔）渲染滚动事件流（tool 调用名+text 片段+时间戳）；空态显示 stream_unavailable 说明。
3. **点入完整视图**：点击成员卡打开抽屉，展示本次任务完整事件列表 + 顶部跳转链接（若有 zcode sessionId 则给出 model-io 文件路径提示只读尾随说明——不自动读盘，路径仅作展示）。
4. **死亡递送**（并入通知链）：委托 timeout/fail 终态时，回灌消息附 events 尾部摘要（最后 3 条 tool/text），取代现在只有 error_type 的干瘪通知。
5. **心跳播报**：delegate 循环节流（60s）将最近活动一行（如「正在写 doc/xxx.md」）经 notifySession 推送，取代队长手工轮询。

### 验收标准
- 运行中的 zcode 任务：面板能看到 run 列表与实时滚动输出；点入可见全量事件历史。
- 失败任务的会话通知包含临终摘要（不再只报 timeout 类型）。
- 缓冲溢出行为明确（>200 条丢弃最旧）且不影响主委托链路（emit 异常吞掉已有 try/catch）。


---

## 队长附言 2：u3 拆分为前后端并行（2026-08-27）

> 队长勘误：原 u3 把前端 UI 重构误派给 developer-1。按团队角色分工重新划分：
> 【u3a 后端】developer-1 负责 B/C/D/E 中与 client 无关的部分：DAG 归属修正(写库侧)、task/list 兜底(查询侧)、空闲超时机制(delegation-service)、executor/run-events 新 RPC。
> 【u3b 前端】frontend-1 负责 TeamsPage CRUD 交互重做(A 全部) + 成员卡实时输出流/点入抽屉(E 的 UI 面) + 死亡递送/心跳的通知展示面。
> 衔接契约 = 本 spec「E 块需求」定义的 executor/run-events 出入参；frontend 侧可先用 mock 数据并行开工，RPC 落地后联调。两边均不得触碰 host-wiring.ts 注册外壳修复。


---

## 队长附言 3：分工最终裁定（2026-08-27，覆盖附言2的执行方式）

> 正在进行中的原 u3（developer-1 已领取）：继续执行，但范围收敛为【纯后端】= 附言1 B/C/D 块 + E 的 RPC/死亡递送/心跳（跳过 A TeamsPage 重构与 E 的 UI 面）。完成后在实现备注节标注「backend done」。
> frontend-1：直接领取并执行 dag-session-adhoc-4-u3b（TeamsPage 重构 + 执行器运行浏览器 UI 面），与 u3 后端并行；RPC 未就绪前按 spec「E 块需求」契约 mock 开发。
> developer-1 完成后端后若有余力，仅在前端出现阻塞时按队长指令协助，不得默认接手 UI。
> 调度事实说明：本调度器为同角色单并发，并行度来自不同角色各领一活。
