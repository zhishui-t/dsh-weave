/// <reference lib="dom" />

/**
 * dsh-weave client plugin — 在 DSH Web 设置页注册一个可见的 Weave 界面入口。
 *
 * 参考 DSH 客户端插件模式（dsh-super-injector / dsh-agent-teams）：
 * - package.json 的 dsh.client.platform = "web"
 * - client 入口导出 { inject: ["slots"], apply }
 * - apply 通过 ctx.slots.inject("settings.section", ...) 注册设置页
 */

const inject = ['slots']

interface SlotView {
  render(): { dispose(): void }
}

interface SlotDefinition {
  name: string
  id: string
  order: number
  label: string | (() => string)
}

interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(def: SlotDefinition, view: () => SlotView): unknown
}

interface ClientContext {
  effect(execute: () => unknown, label?: string): unknown
  slots: SlotsService
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const styles = `
.dsh-weave-page{font-family:ui-monospace,monospace;font-size:13px;line-height:1.6;padding:16px;max-width:720px}
.dsh-weave-page h2{margin:0 0 8px}
.dsh-weave-card{border:1px solid var(--theme-border,#333);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--theme-input-bg,#111)}
.dsh-weave-card .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:rgba(74,158,255,.15);color:#4a9eff}
.dsh-weave-code{background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;font-family:ui-monospace,monospace;font-size:12px}
`

function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-weave',
            order: 80,
            label: () => 'Weave',
          },
          () => ({
            render() {
              const style = document.createElement('style')
              style.textContent = styles

              const page = el('div', 'dsh-weave-page')
              page.append(style, el('h2', undefined, 'Weave 协作框架'))

              const status = el('div', 'dsh-weave-card')
              status.append(el('span', 'badge', 'dsh-weave v0.2.0'))
              status.append(el('div', undefined, '多 Agent 团队协作 / 任务 DAG / 知识库 / 执行器管理'))
              page.append(status)

              const cmds = el('div', 'dsh-weave-card')
              cmds.append(el('h3', undefined, '常用命令'))
              const examples = [
                '/weave team list',
                '/weave team switch <team_id>',
                '/weave task submit "任务" --project p1 --version v1',
                '/weave task status --dag <dag_id>',
                '/weave executor list',
                '/weave knowledge review',
              ]
              for (const line of examples) cmds.append(el('div', 'dsh-weave-code', line))
              page.append(cmds)

              return { dispose() { } }
            },
          }),
        ),
      ),
    'dsh-weave client settings page',
  )
}

export { apply, inject }
