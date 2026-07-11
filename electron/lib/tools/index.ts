import type { ToolSet } from 'ai'
import type { SendMessageInput } from '../../../shared/chat'
import { getMcpTools } from '../mcp'
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
import { createSkillTool } from './create-skill'
import { createChatMemoryTools, createCodeMemoryTools } from './memory'
import { createSubagentTool } from './orchestration'
import { createPanelBrowserTools } from './panel-browser'
import { createQuestionTool } from './question'
import { createBashTool } from './shell'
import { createTodoTool } from './todo'
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
  // question: sessão principal sempre; workers só quando o pai não está em "full"
  // (em "ask" a pergunta sobe ao usuário; em "approve" é auto-respondida)
  const allowQuestion =
    input.orchestrationRole !== 'worker' || (input.options.permissionMode ?? 'ask') !== 'full'

  // Tools de servidores MCP configurados: disponíveis em ambos os modos
  Object.assign(tools, getMcpTools())

  // Propor skills vale nos dois modos (fluxo /create-skill inicia em chat);
  // workers não criam skills
  if (input.orchestrationRole !== 'worker') tools.create_skill = createSkillTool()

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
    if (allowQuestion) tools.question = createQuestionTool(input, ctx?.abort)
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
    tools.todowrite = createTodoTool()
    if (!input.options.plan) {
      tools.write = createWriteTool(ctx)
      tools.edit = createEditTool(ctx)
      tools.bash = createBashTool(ctx)
    }
  }
  // Browser do painel direito: teste de apps web + modo documentação.
  // Workers ficam de fora — o painel é um recurso único e visível.
  if (ctx && input.orchestrationRole !== 'worker') {
    Object.assign(tools, createPanelBrowserTools(ctx))
  }
  if (allowBrain && ctx) Object.assign(tools, createCodeMemoryTools(input, ctx))
  if (allowQuestion) tools.question = createQuestionTool(input, ctx?.abort)
  if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)

  return tools
}
