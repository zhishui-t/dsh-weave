# Test & Tooling

- `e2e/`：Playwright 端到端测试（features / harness / live / archive）。
- `scripts/`：开发辅助脚本（环境检查、E2E 诊断、队长计划模拟等）。

运行 Playwright 时请使用项目根目录命令：
- `pnpm test:e2e`
- `pnpm test:e2e:harness`
- `WEAVE_E2E_LIVE=1 pnpm test:e2e:live`
