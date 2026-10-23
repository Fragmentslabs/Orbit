import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import { getMcpTools } from '../mcp'
import { createArtifactTools } from './artifact'
import { createDocumentTools, createPdfViewTool } from './documents'
import { createSheetQueryTool } from './sheet'
import { createDocumentAuthoringTools } from './document'
import { createDocxEditTools } from './docx'
import { createImageTools, type ImageToolHooks } from './image'
import { createPdfOpsTools } from './pdf'
import { createSvgTools } from './svg'
import { createBrowserLinksTool, createBrowserOpenTool } from './browser'
import { createBrowserScriptTools } from './browser-script'
import { createBrowserRecordTools } from './browser-record'
import { createEsteiraTools } from './esteira'
import { createWorktreeTools } from './worktrees'
import { createSessionTools } from './sessions'
import { createUsageTools } from './usage'
import type { ToolContext } from './context'
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createWriteTool,
} from './files'
import { createCodeTools } from './code'
import { createSkillTool } from './create-skill'
import { createSkillReadTool } from './skill-read'
import { createMcpTools } from './mcp'
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
import { agentMayControlComputer, agentMayUseBrowser, getAppSettings } from '../app-settings'
import { isComputerAvailable } from '../computer'
import { createComputerTools } from './computer'
import { createAudioGenerateTool, createAudioTranscribeTool } from './audio'
import { createVideoTools } from './video'
import { createChatMotionTools } from './motion-chat'
import { createChatDesignTools } from './design-chat'
import { createPanelTools } from './panel'
import { createDesignTools } from './design'
import { createGalleryShowImageTool, createImageSearchTools } from './image-search'
import { createFontTools } from './fonts'
import { resolveFfmpeg } from '../video/ffmpeg'

export { destroyBrowserWindow } from './browser'
export type { ToolContext, TurnSnapshot } from './context'
export type { ImageToolHooks } from './image'

/**
 * Monta o conjunto de ferramentas de acordo com o modo, seguindo a lógica de
 * agentes do opencode: "plan" só permite leitura; "build" (código) tem acesso
 * completo; no chat cada toggle controla estritamente sua capacidade —
 * Pesquisa habilita web, Browser habilita o browser nativo.
 *
 * `imageHooks` liga o image_delete ao estado vivo da resposta em andamento
 * (chat-engine) — sem ele a tool ainda existe mas se recusa a apagar nada.
 */
export function buildToolSet(
  input: SendMessageInput,
  ctx: ToolContext | null,
  imageHooks?: ImageToolHooks,
  /** Visão do modelo do turno — no chat não há ctx para carregá-la */
  modelVision?: boolean,
): ToolSet {
  const tools: ToolSet = {}
  // Controle do computador: duas chaves (Preferências + modo da conversa),
  // só a sessão principal e só onde há driver. Desligado, as tools nem
  // existem — o prompt explica ao agente como ligar.
  if (agentMayControlComputer(input, isComputerAvailable())) {
    Object.assign(
      tools,
      createComputerTools({
        sessionId: input.sessionId,
        modelVision: modelVision ?? ctx?.modelVision !== false,
        visionModel: input.visionModel,
      }),
    )
  }
  // Skills: no prompt entram com a descrição; o conteúdo completo vem sob
  // demanda (skill_read), para que uma skill nativa não pague o texto inteiro
  // em todo turno. Não expõe capacidade nova — só lê o que o agente já vê.
  tools.skill_read = createSkillReadTool(ctx?.directory)
  // Áudio: sem interruptor próprio — cada metade segue a da voz nas
  // Preferências (Fala em texto → transcrever; Texto em fala → gerar).
  // Desligada, a tool nem existe e o prompt explica ao agente como ativar.
  const voice = getAppSettings().voice
  const addAudioTools = (scope: ToolContext | null) => {
    if (voice.stt.enabled) {
      tools.audio_transcribe = createAudioTranscribeTool({ sessionId: input.sessionId, directory: input.directory, language: input.language }, scope)
    }
    if (voice.tts.enabled) tools.audio_generate = createAudioGenerateTool(input.sessionId, scope)
  }
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
    // Modo chat: as tools de fábrica só entram quando um toggle está ativo, e
    // cada toggle expõe apenas as suas próprias. Servidores MCP são a exceção:
    // existem sempre que há servidor ligado, recortados pela escolha desta
    // conversa (`toolsServers`; ausente = todos).
    if (input.options.research) {
      tools.websearch = createWebSearchTool()
      tools.webfetch = createWebFetchTool()
      Object.assign(tools, createImageSearchTools({ sessionId: input.sessionId, modelVision: ctx?.modelVision !== false }))
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
      // O que está aberto na aba lateral agora — deixa o agente responder a
      // "isso"/"aqui" sem o usuário reanexar. Read-only, sem permissão.
      Object.assign(tools, createPanelTools(input.sessionId))
      // Mostrar uma imagem do app na resposta: no chat o markdown de imagem é
      // bloqueado, e este é o único caminho.
      Object.assign(tools, createGalleryShowImageTool())
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
      // Editar .docx anexado: a copia fica no Orbit, o original nao e tocado.
      Object.assign(tools, createDocxEditTools({ sessionId: input.sessionId }, null))
      Object.assign(tools, createPdfOpsTools({ sessionId: input.sessionId }, null))
      // Editar imagem por processamento de pixel (redimensionar, comprimir,
      // ajustar tom, tirar o fundo). No chat a fonte e sempre a galeria — todo
      // anexo de imagem e registrado la —, por isso ctx entra como null.
      Object.assign(tools, createImageTools({ sessionId: input.sessionId }, null, imageHooks))
      // SVG e imagem sao tools separadas porque a natureza e outra: uma
      // reprocessa pixel, a outra reescreve texto.
      Object.assign(tools, createSvgTools({ sessionId: input.sessionId }, null))
      // No chat o áudio vem sempre de um anexo (não há pasta de trabalho).
      addAudioTools(null)
      // Motion: sem pasta de trabalho, a composição mora no armazenamento do
      // Orbit (uma pasta por conversa) e é escrita/editada por nome — a mesma
      // aba Motion, ao vivo. O render só existe com o ffmpeg do app.
      Object.assign(
        tools,
        createChatMotionTools({
          sessionId: input.sessionId,
          modelVision: ctx?.modelVision !== false,
          canRender: resolveFfmpeg() !== null,
        }),
      )
      // Design: mesmo molde do motion acima — sem pasta de trabalho, o canvas
      // mora no armazenamento do Orbit e é escrito/editado por nome, a mesma
      // aba Design, ao vivo.
      Object.assign(tools, createChatDesignTools({ sessionId: input.sessionId }))
      // Fontes externas (biblioteca do Orbit): instalar não pede permissão nem
      // escreve no projeto — o scheme orbit-font:// entrega o arquivo ao
      // artboard e à composição. Sem toggle: não expõe nada que o app já não
      // faça ao renderizar uma fonte.
      Object.assign(tools, createFontTools())
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
      // Relatório de horas/custo: a mesma conta da tela de uso, para o agente
      // responder "quantas horas no projeto X" sem chutar. Fora dos workers
      // porque quem escreve o relatório é a sessão que fala com o usuário.
      Object.assign(tools, createUsageTools())
    }
    if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
    // Modo Visão: ver as imagens anexadas é decisão do agente — a tool
    // describe_image descreve sob demanda (com o contexto que ele passar).
    if (input.visionModel) tools.describe_image = createDescribeImageTool(input)
    // Servidores MCP: não são toggle — as tools existem sempre, recortadas
    // pela escolha desta conversa (ausente = todos os ligados no app).
    Object.assign(
      tools,
      getMcpTools({
        sessionId: input.sessionId,
        canShow: input.orchestrationRole !== 'worker',
        canDescribe: Boolean(input.visionModel),
        only: input.options.toolsServers,
      }),
    )
    // Fluxo explícito /create-skill: habilita só a tool de propor skill
    if (input.orchestrationRole !== 'worker' && input.text.trimStart().startsWith('/create-skill')) {
      tools.create_skill = createSkillTool()
    }
    // Conexões MCP: propor uma conexão nova, corrigir uma existente e ler o
    // estado. Elas só propõem — quem aplica é o card na conversa —, então não
    // são um toggle: valem em qualquer conversa, como a esteira e os chats.
    if (input.orchestrationRole !== 'worker') Object.assign(tools, createMcpTools())
    return tools
  }

  // Modo código: MCP disponível (servidores configurados) + skill flow, com o
  // recorte da conversa (`toolsServers`; ausente = todos, que é também o de
  // quem chama o engine sem passar pelo composer: celular, rotinas, esteira).
  // As imagens que um servidor devolve vão para a galeria deste chat; o
  // resultado diz ao modelo como mostrá-las ou olhá-las — por isso o MCP
  // precisa saber se show_image e describe_image existem neste turno (as
  // condições espelham as de mais abaixo).
  Object.assign(
    tools,
    getMcpTools({
      sessionId: input.sessionId,
      canShow: ctx !== null && input.orchestrationRole !== 'worker',
      canDescribe: Boolean(input.visionModel),
      only: input.options.toolsServers,
    }),
  )
  if (input.orchestrationRole !== 'worker') {
    tools.create_skill = createSkillTool()
    // Conexões MCP: propor uma conexão nova, corrigir uma existente e ler o
    // estado. Só propõem — quem aplica é o card na conversa.
    Object.assign(tools, createMcpTools())
    // Artefatos também no código: relatório de análise, diagrama de
    // arquitetura, comparativo — coisas que o usuário quer VER e que não
    // deveriam virar arquivo solto no repositório dele.
    Object.assign(tools, createArtifactTools(input.sessionId))
    // O que está aberto no painel (tool read_open_panel) — vale nos dois modos.
    Object.assign(tools, createPanelTools(input.sessionId))
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
    Object.assign(
      tools,
      createDocxEditTools({ sessionId: input.sessionId, directory: input.directory }, ctx),
    )
    Object.assign(
      tools,
      createPdfOpsTools({ sessionId: input.sessionId, directory: input.directory }, ctx),
    )
    // No codigo a imagem tambem pode vir da pasta de trabalho (um asset do
    // projeto), entao aqui o ctx entra — e com ele o savePath, para gravar a
    // versao editada de volta no repositorio quando o usuario pedir.
    Object.assign(
      tools,
      createImageTools({ sessionId: input.sessionId, directory: input.directory }, ctx, imageHooks),
    )
    Object.assign(
      tools,
      createSvgTools({ sessionId: input.sessionId, directory: input.directory }, ctx),
    )
    // No código o áudio também pode ser um arquivo da pasta (e o gerado pode
    // ser gravado nela).
    addAudioTools(ctx)
  }

  if (input.options.research) {
    tools.websearch = createWebSearchTool()
    tools.webfetch = createWebFetchTool()
    Object.assign(tools, createImageSearchTools({ sessionId: input.sessionId, modelVision: ctx?.modelVision !== false }))
  }
  if (ctx) {
    tools.read = createReadTool(ctx)
    tools.ls = createListTool(ctx)
    tools.glob = createGlobTool(ctx)
    tools.grep = createGrepTool(ctx)
    // Índice de símbolos: acha o trecho certo (arquivo:linha + código + quem
    // usa) numa chamada, no lugar da rodada grep → read → read.
    Object.assign(tools, createCodeTools(ctx))
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
  // Vídeo e motion: precisam de pasta (as saídas vão para edit/ ao lado do
  // material) e do ffmpeg que vem com o app. Workers entram — a skill manda
  // fazer cada animação num sub-agente em paralelo —, mas não mostram player:
  // quem fala com o usuário é a sessão principal.
  if (ctx && resolveFfmpeg()) {
    Object.assign(
      tools,
      createVideoTools(ctx, {
        sessionId: input.sessionId,
        canShow: input.orchestrationRole !== 'worker',
        readOnly: Boolean(input.options.plan),
      }),
    )
  }
  // Design: só precisa de pasta (sem ffmpeg nenhum) — o agente escreve o
  // canvas com write/edit e design_preview abre a aba, como motion_preview faz
  // com a composição. Workers ficam de fora: o painel é um recurso visível, só
  // da sessão principal.
  if (ctx && input.orchestrationRole !== 'worker') {
    Object.assign(tools, createDesignTools(ctx, { sessionId: input.sessionId }))
    Object.assign(tools, createFontTools())
  }

  // Browser do painel direito: teste de apps web + modo documentação.
  // Workers ficam de fora — o painel é um recurso único e visível. Com as
  // ferramentas de navegador desligadas nas Preferências, só quando o pedido
  // veio do próprio navegador em tela cheia (ver agentMayUseBrowser).
  if (ctx && input.orchestrationRole !== 'worker') {
    const panelTools = createPanelBrowserTools(ctx)
    if (agentMayUseBrowser(input)) {
      Object.assign(tools, panelTools)
      // Automação em lote: roda numa janela oculta, sem disputar o painel.
      Object.assign(tools, createBrowserScriptTools(ctx))
      // Gravação de um roteiro em vídeo (mesma janela oculta, captura por CDP).
      // Não pede permissão e não abre janela — mas só deve ser chamada quando o
      // usuário pede uma gravação (ver a descrição da tool).
      Object.assign(tools, createBrowserRecordTools(ctx))
    } else {
      // show_image também mostra imagens do projeto e da galeria — isso não é
      // usar o navegador, então fica.
      tools.show_image = panelTools.show_image
    }
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
    Object.assign(tools, createUsageTools())
    // Worktrees: trocar a pasta do chat é decisão da sessão principal — um
    // worker mudando a pasta de quem o chamou desorientaria a conversa.
    if (ctx) Object.assign(tools, createWorktreeTools(ctx))
  }
  if (allowQuestion) tools.question = createQuestionTool(input, ctx?.abort)
  if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
  // Modo Visão: ver as imagens anexadas é decisão do agente — a tool
  // describe_image descreve sob demanda (com o contexto que ele passar).
  if (input.visionModel) tools.describe_image = createDescribeImageTool(input)

  return tools
}
