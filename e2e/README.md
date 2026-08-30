# Playwright E2E

- `features/`：面向实际能力/服务的端到端用例（Graphify、AnyDoc、Obsidian、知识图谱、控制台服务契约等）。
- `harness/`：基于虚拟域和真实构建产物驱动 UI 的 harness 用例，不依赖真实 DSH Web。
- `live/`：真实 DSH Web 冒烟用例，默认由 `WEAVE_E2E_LIVE=1` 门控。
- `archive/`：已淘汰的旧 UI harness 用例，默认不运行。
- `helpers.ts`：两层共享的地址、环境探测、报告工具。

运行：

- `pnpm test:e2e`
- `pnpm test:e2e:harness`
- `WEAVE_E2E_LIVE=1 pnpm test:e2e:live`
