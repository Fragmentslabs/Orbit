import type { ToolSet } from 'ai'
import type { SendMessageInput } from '../../../shared/chat'
import { createBrowserLinksTool, createBrowserOpenTool } from './browser'
import type { ToolContext } from './context'
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createWriteTool,
} from './files'
import { createChatMemoryTools, createCodeMemoryTools } from './memory'
import { createSubagentTool } from './orchestration'
import { createBashTool } from './shell'
import { createWebFetchTool, createWebSearchTool } from './web'

export { destroyBrowserWindow } from './browser'
export type { ToolContext } from './context'

/**
 * Monta o conjunto de ferramentas de acordo com o modo, seguindo a lógica de
 * agentes do opencode: "plan" só permite leitura; "build" (código) tem acesso
 * completo; no chat cada toggle controla estritamente sua capacidade —
 * Pesquisa habilita web, Browser habilita o browser nativo.
 */
export function buildToolSet(input: SendMessageInput, ctx: ToolContext | null): ToolSet {
  const tools: ToolSet = {}
  // Regra de ouro: workers nunca delegam (sem recursão de subagents/orchestra)
  const allowDelegation = input.options.subagents === true && input.orchestrationRole !== 'worker'
  // Brain: memória persistente — workers também ficam de fora
  const allowBrain = input.options.brain === true && input.orchestrationRole !== 'worker'

  if (input.mode === 'chat') {
    if (input.options.research) {
      tools.websearch = createWebSearchTool()
      tools.webfetch = createWebFetchTool()
    }
    if (input.options.browser) {
      tools.browser_open = createBrowserOpenTool(input.sessionId)
      tools.browser_links = createBrowserLinksTool(input.sessionId)
    }
    if (allowBrain) Object.assign(tools, createChatMemoryTools(input))
    if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
    return tools
  }

  // Modo código: web somente com o toggle de pesquisa; escrita/shell bloqueados no plano
  if (input.options.research) {
    tools.websearch = createWebSearchTool()
    tools.webfetch = createWebFetchTool()
  }
  if (ctx) {
    tools.read = createReadTool(ctx)
    tools.ls = createListTool(ctx)
    tools.glob = createGlobTool(ctx)
    tools.grep = createGrepTool(ctx)
    if (!input.options.plan) {
      tools.write = createWriteTool(ctx)
      tools.edit = createEditTool(ctx)
      tools.bash = createBashTool(ctx)
    }
  }
  if (allowBrain && ctx) Object.assign(tools, createCodeMemoryTools(input, ctx))
  if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)

  return tools
}
