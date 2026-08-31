import { buildCodeGraph } from './web/console-rpc.js'

export interface WeaveCommandLike {
  register(definition: {
    name: string
    description: string
    input: { hint: string }
    handler(invocation: { rawInput: string }): Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => void
}

export interface GraphCommandContext {
  commands?: WeaveCommandLike
}

/**
 * Register a `/weave code build` host command so users can build/refresh the
 * code graph from a session, without needing the Web console.
 */
export function registerCodeGraphCommand(ctx: GraphCommandContext): void {
  const commands = ctx.commands
  if (!commands?.register) return
  commands.register({
    name: 'weave',
    description: 'Weave code graph command. Use: /weave code build [projectRoot] [sourceDir]',
    input: {
      hint: 'weave code build [projectRoot] [sourceDir]',
    },
    async handler(invocation) {
      const argv = invocation.rawInput.trim().split(/\s+/).filter((item) => item !== '')
      if (argv[0] !== 'code' || argv[1] !== 'build') {
        return { kind: 'error', text: '用法：/weave code build [projectRoot] [sourceDir]' }
      }
      try {
        const result = await buildCodeGraph({
          ...(argv[2] ? { projectRoot: argv[2] } : {}),
          ...(argv[3] ? { sourceDir: argv[3] } : {}),
        })
        return {
          kind: 'success',
          text: `代码图谱已更新\n图谱：${result.graphPath}\n执行流：${result.flowsPath}`,
        }
      } catch (error) {
        return {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}
