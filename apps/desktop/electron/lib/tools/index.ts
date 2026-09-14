import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import { getMcpTools } from '../mcp'
import { createArtifactTools } from './artifact'
import { createDocumentTools, createPdfViewTool } from './documents'
import { createSheetQueryTool } from './sheet'
import { createDocumentAuthoringTools } from './document'
import { createBrowserLinksTool, createBrowserOpenTool } from './browser'
import { createBrowserScriptTools } from './browser-script'
import { createEsteiraTools } from './esteira'
import { createSessionTools } from './sessions'
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
import { createChatMemoryTools, createCodeMemoryTools, createGraphTool } from './memory'
import { createSubagentTool } from './orchestration'
import { createPanelBrowserTools } from './panel-browser'
import { createQuestionTool } from './question'
import { createBackgroundTools } from './background'
import { createBashTool } from './shell'
import { createTodoTool } from './todo'
import { createSessionContextTool } from './session-context'
import { createVerifyChangesTool } from './verify-changes'
import { createDescribeImageTool } from './describe-image'
import { createWebFetchTool, createWebSearchTool } from './web'

export { destroyBrowserWindow } from './browser'
export type { ToolContext, TurnSnapshot } from './context'

/**
 * Monta o conjunto de ferramentas de acordo com o modo, seguindo a lógica de
 * agentes do opencode: "plan" só permite leitura; "build" (código) tem acesso
 * completo; no chat cada toggle controla estritamente sua capacidade —
 * Pesquisa habilita web, Browser habilita o browser nativo.
 */
export function buildToolSet(input: SendMessageInput, ctx: ToolContext | null): ToolSet {
  const tools: ToolSet = {}
  // Regra de ouro: workers podem usar subagentes, mas NUNCA orquestrar (sem recursão infinita).
  // Se orchestrate está ativo (este worker é um orquestrador), bloqueamos delegação.
  const allowDelegation = input.options.subagents === true && !input.options.orchestrate
  // Brain: ferramentas de memória — workers também ficam de fora
  const allowBrain = input.options.brain === true && input.orchestrationRole !== 'worker'
  // question: sessão principal sempre; workers só quando o pai não está em "full"
  // (em "ask" a pergunta sobe ao usuário; em "approve" é auto-respondida)
  const allowQuestion =
    input.orchestrationRole !== 'worker' || (input.options.permissionMode ?? 'ask') !== 'full'

  if (input.mode === 'chat') {
    // Modo chat: SEM tools MCP — um chat básico não deve ter nenhuma tool.
    // As tools só aparecem quando um toggle está ativo, e cada toggle expõe
    // apenas as suas próprias (nunca servidores MCP externos).
    if (input.options.research) {
      tools.websearch = createWebSearchTool()
      tools.webfetch = createWebFetchTool()
    }
    if (input.options.browser) {
      tools.browser_open = createBrowserOpenTool(input.sessionId)
      tools.browser_links = createBrowserLinksTool(input.sessionId)
    }
    // Artefatos HTML: no chat o agente não tem write/bash — é a única forma
    // dele entregar algo renderizável. Não é toggle (não expõe capacidade
    // nova: não lê, não escreve no projeto, não acessa a rede em nome do
    // agente) e workers ficam de fora, porque quem responde ao usuário é a
    // sessão principal.
    if (input.orchestrationRole !== 'worker') {
      Object.assign(tools, createArtifactTools(input.sessionId))
    }
    // Documentos anexados: o equivalente do read/grep para o chat, que não
    // tem nenhum dos dois. Sempre disponíveis — quando não há anexo, doc_list
    // responde que não há, e é justamente isso que impede o agente de
    // alucinar sobre um documento que ele não leu.
    Object.assign(tools, createDocumentTools(input.sessionId))
    // Ver pagina de PDF: no chat a fonte e sempre um anexo.
    tools.pdf_view_page = createPdfViewTool(input.sessionId, null, ctx?.modelVision !== false)
    // Consulta de planilha: no chat a fonte e sempre um anexo (nao ha pasta
    // de trabalho), por isso ctx entra como null.
    tools.sheet_query = createSheetQueryTool(input.sessionId, null)
    // Documentos entregaveis (PDF/DOCX). No chat o escopo e a pasta da
    // sidebar, quando houver — nao existe diretorio de trabalho aqui.
    if (input.orchestrationRole !== 'worker') {
      Object.assign(
        tools,
        createDocumentAuthoringTools({ sessionId: input.sessionId }),
      )
    }
    if (allowBrain) Object.assign(tools, createChatMemoryTools(input))
    // Esteira: transformar o que foi discutido no chat em esteira/task de um
    // board. Fica sempre disponível (não é toggle): a esteira é outra forma de
    // trabalhar, não um modo da conversa — o chat só empurra trabalho pra lá.
    // Workers ficam de fora: quem decide o que vira task é a sessão principal.
    if (input.orchestrationRole !== 'worker') {
      Object.assign(tools, createEsteiraTools(input.sessionId, input))
      // Manutenção de chats (listar por inatividade, arquivar, excluir): base
      // das rotinas de limpeza. Fora dos workers pelo mesmo motivo da esteira —
      // quem decide o que sai da sidebar é a sessão principal.
      Object.assign(tools, createSessionTools())
    }
    if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
    // Modo Visão: ver as imagens anexadas é decisão do agente — a tool
    // describe_image descreve sob demanda (com o contexto que ele passar).
    if (input.visionModel) tools.describe_image = createDescribeImageTool(input)
    // Fluxo explícito /create-skill: habilita só a tool de propor skill
    if (input.orchestrationRole !== 'worker' && input.text.trimStart().startsWith('/create-skill')) {
      tools.create_skill = createSkillTool()
    }
    return tools
  }

  // Modo código: MCP disponível (servidores configurados) + skill flow
  Object.assign(tools, getMcpTools())
  if (input.orchestrationRole !== 'worker') {
    tools.create_skill = createSkillTool()
    // Artefatos também no código: relatório de análise, diagrama de
    // arquitetura, comparativo — coisas que o usuário quer VER e que não
    // deveriam virar arquivo solto no repositório dele.
    Object.assign(tools, createArtifactTools(input.sessionId))
  }
  // Documentos anexados também no código: `read`/`grep` alcançam o
  // repositório, não o que o usuário arrastou para a conversa. Sem isto, o
  // trecho de abertura do anexo apontaria para uma tool inexistente.
  Object.assign(tools, createDocumentTools(input.sessionId))
  tools.pdf_view_page = createPdfViewTool(input.sessionId, ctx, ctx?.modelVision !== false)
  // No codigo a consulta alcanca as duas fontes: planilha do repositorio
  // (filePath, via ctx) e planilha anexada na conversa (docId).
  tools.sheet_query = createSheetQueryTool(input.sessionId, ctx)
  // No codigo o escopo e o REPOSITORIO: list_documents reencontra o que foi
  // produzido sobre a mesma pasta de trabalho em qualquer conversa anterior,
  // nao so nesta sessao.
  if (input.orchestrationRole !== 'worker') {
    Object.assign(
      tools,
      createDocumentAuthoringTools({ sessionId: input.sessionId, directory: input.directory }),
    )
  }

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
    // Leitura do estado do turno: verify_changes confere o que foi escrito;
    // session_context traz metadados dos turnos recentes. Ambas são leitura
    // (ok no plano) e não recebem orientação extra no prompt — o modelo
    // decide quando chamá-las.
    tools.verify_changes = createVerifyChangesTool(ctx)
    tools.session_context = createSessionContextTool(ctx)
    if (!input.options.plan) {
      tools.write = createWriteTool(ctx)
      tools.edit = createEditTool(ctx)
      tools.bash = createBashTool(ctx)
      Object.assign(tools, createBackgroundTools(ctx))
    }
  }
  // Browser do painel direito: teste de apps web + modo documentação.
  // Workers ficam de fora — o painel é um recurso único e visível.
  if (ctx && input.orchestrationRole !== 'worker') {
    Object.assign(tools, createPanelBrowserTools(ctx))
    // Automação em lote: roda numa janela oculta, sem disputar o painel.
    Object.assign(tools, createBrowserScriptTools(ctx))
  }
  if (allowBrain && ctx) {
    Object.assign(tools, createCodeMemoryTools(input, ctx))
    tools.memory_graph = createGraphTool(input, ctx)
  }
  if (input.orchestrationRole !== 'worker') {
    Object.assign(tools, createEsteiraTools(input.sessionId, input))
    // Manutenção de chats (listar por inatividade, arquivar, excluir): base
    // das rotinas de limpeza. Fora dos workers pelo mesmo motivo da esteira —
    // quem decide o que sai da sidebar é a sessão principal.
    Object.assign(tools, createSessionTools())
  }
  if (allowQuestion) tools.question = createQuestionTool(input, ctx?.abort)
  if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
  // Modo Visão: ver as imagens anexadas é decisão do agente — a tool
  // describe_image descreve sob demanda (com o contexto que ele passar).
  if (input.visionModel) tools.describe_image = createDescribeImageTool(input)

  return tools
}
