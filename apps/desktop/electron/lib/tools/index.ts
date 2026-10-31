import type { BrowserWindow } from 'electron'
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
import { createPipelineTools } from './pipeline'
import { createRoutinesTool } from './routines'
import { createWorktreeTools } from './worktrees'
import { createSessionTools } from './sessions'
import { createChatSearchTools } from './chat-search'
import { createSubchatTools } from './subchats'
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
import { createUserNameTool } from './user-name'
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
import { createRunToolsTool } from './run-tools'
import { createDescribeImageTool } from './describe-image'
import { createWebFetchTool, createWebSearchTool } from './web'
import { agentMayControlComputer, agentMayUseBrowser, getAppSettings } from '../app-settings'
import { isComputerAvailable, markOverlaySession } from '../computer'
import { createComputerTools } from './computer'
import { createComputerTaskTool } from './computer-task'
import { createEndCallTool, createOverlayTools } from './overlay'
import { createAudioGenerateTool } from './audio'
import { createMediaTools } from './media-compress'
import { createVideoTools } from './video'
import { createYtdlpTools } from './ytdlp'
import { createMotionTools } from './motion'
import { createDesignTools } from './design'
import { createSlidesTools } from './slides'
import { createPieceExportTool } from './piece-export'
import { createPanelTools } from './panel'
import { createGalleryShowImageTool, createImageSearchTools } from './image-search'
import { createFontTools } from './fonts'
import { resolveFfmpeg } from '../video/ffmpeg'

export { destroyBrowserWindow } from './browser'
export type { ToolContext, TurnSnapshot } from './context'
export type { ImageToolHooks } from './image'

/**
 * Assembles the tool set according to the mode, following opencode's agent
 * logic: "plan" only allows reading; "build" (code) has full
 * access; in the chat each toggle strictly controls its own capability —
 * Search enables web, Browser enables the native browser.
 *
 * `imageHooks` ties image_delete to the live state of the response in progress
 * (chat-engine) — without it the tool still exists but refuses to delete anything.
 */
export function buildToolSet(
  input: SendMessageInput,
  ctx: ToolContext | null,
  imageHooks?: ImageToolHooks,
  /** Vision of the turn's model — in the chat there is no ctx to load it from */
  modelVision?: boolean,
  /** Turn window: the subchat needs it to fire its own turn.
   *  Absent in ephemeral workers — there the tool is not registered. */
  win?: BrowserWindow,
): ToolSet {
  const tools: ToolSet = {}
  // Computer control: two switches (Preferences + conversation mode),
  // main session only and only where there is a driver. When off, the tools do not
  // even exist — the prompt explains to the agent how to turn it on.
  if (agentMayControlComputer(input, isComputerAvailable())) {
    Object.assign(
      tools,
      createComputerTools({
        sessionId: input.sessionId,
        modelVision: modelVision ?? ctx?.modelVision !== false,
        visionModel: input.visionModel,
        conversation: { providerId: input.providerId, modelId: input.modelId },
      }),
    )
    // Subagent: the multi-action loop runs with a short context (and the
    // Preferences → Computer model, if any), not on every step here.
    tools.computer_task = createComputerTaskTool(input, ctx?.abort)
  }
  // Skills: they enter the prompt with the description; the full content comes on
  // demand (skill_read), so that a native skill does not pay for the whole text
  // on every turn. It exposes no new capability — it only reads what the agent already sees.
  tools.skill_read = createSkillReadTool(ctx?.directory)
  // Identity: the name the person said, in the SAME Preferences field. Automatic
  // detection covers "my name is X"; this tool covers the rest —
  // "I am Rafael", a correction, and the request to forget the name. Workers
  // stay out: whoever talks to the person is the main session.
  if (input.orchestrationRole !== 'worker') tools.set_user_name = createUserNameTool()
  // Audio: "Text to speech" enables generation here; reading (speech to text) is the
  // `transcribe` tool, which lives with the media tools and also only exists with
  // the switch on — when off, the prompt explains to the agent how to enable it.
  const voice = getAppSettings().voice
  const addAudioTools = (scope: ToolContext | null) => {
    if (voice.tts.enabled) tools.audio_generate = createAudioGenerateTool(input.sessionId, scope)
  }
  // Overlay (⇧⌘space): the question is about what is on the SCREEN. Without these two
  // tools the agent would answer in the dark and ask the person to paste the text.
  // Only overlays expose them — in the normal chat the cost of one image per turn is not
  // justified. `end_call` holds in any spoken conversation.
  if (input.options.overlay) {
    // When driven from the shortcut, the status is shown by the panel itself (see session.ts).
    markOverlaySession(input.sessionId)
    Object.assign(
      tools,
      createOverlayTools({
        // With no declared vision, the safe answer is NOT to attach an image: a
        // text-only model with a screenshot attached breaks or makes things up.
        modelVision: modelVision ?? ctx?.modelVision ?? false,
        visionModel: input.visionModel,
        sessionId: input.sessionId,
      }),
    )
  }
  if (input.options.overlay || input.options.voiceCall) tools.end_call = createEndCallTool()
  // Golden rule: workers may use subagents, but NEVER orchestrate (no infinite recursion).
  // If orchestrate is active (this worker is an orchestrator), delegation is blocked.
  const allowDelegation = input.options.subagents === true && !input.options.orchestrate
  // Brain: memory tools — workers stay out too
  const allowBrain = input.options.brain === true && input.orchestrationRole !== 'worker'
  // question: main session always; workers only when the parent is not in "full"
  // (in "ask" the question goes up to the user; in "approve" it is auto-answered)
  const allowQuestion =
    input.orchestrationRole !== 'worker' || (input.options.permissionMode ?? 'ask') !== 'full'

  // Routines: the agent schedules from the chat. The "create" action only
  // PROPOSES — the conversation card is what creates it; the other actions are
  // immediate. Kept out of workers (scheduling is for whoever talks to the
  // person) and out of plan mode (it writes the proposal to disk).
  if (input.orchestrationRole !== 'worker' && !input.options.plan) {
    tools.routines_manage = createRoutinesTool(input)
  }

  if (input.mode === 'chat') {
    // Chat mode: the built-in tools only enter when a toggle is active, and
    // each toggle exposes only its own. MCP servers are the exception:
    // they exist whenever there is a server on, sliced by this
    // conversation's choice (`toolsServers`; absent = all).
    if (input.options.research) {
      tools.websearch = createWebSearchTool()
      tools.webfetch = createWebFetchTool()
      // In the chat `ctx` is null by construction: the turn's vision comes from the
      // `modelVision` parameter (that is why it exists — see the comment above).
      Object.assign(tools, createImageSearchTools({ sessionId: input.sessionId, modelVision: modelVision !== false }))
    }
    if (input.options.browser) {
      tools.browser_open = createBrowserOpenTool(input.sessionId)
      tools.browser_links = createBrowserLinksTool(input.sessionId)
    }
    // HTML artifacts: in the chat the agent has no write/bash — it is the only way
    // for it to deliver something renderable. It is not a toggle (it exposes no new
    // capability: it does not read, does not write to the project, does not access the network on the
    // agent's behalf) and workers stay out, because whoever answers the user is the
    // main session.
    if (input.orchestrationRole !== 'worker') {
      Object.assign(tools, createArtifactTools(input.sessionId))
      // What is open in the side tab right now — it lets the agent answer
      // "this"/"here" without the user re-attaching. Read-only, no permission.
      Object.assign(tools, createPanelTools(input.sessionId))
      // Showing an app image in the response: in the chat image markdown is
      // blocked, and this is the only path.
      Object.assign(tools, createGalleryShowImageTool())
    }
    // Attached documents: the equivalent of read/grep for the chat, which has
    // neither of them. Always available — when there is no attachment, doc_list
    // answers that there is none, and that is exactly what keeps the agent from
    // hallucinating about a document it did not read.
    Object.assign(tools, createDocumentTools(input.sessionId))
    // Viewing a PDF page: in the chat the source is always an attachment.
    tools.pdf_view_page = createPdfViewTool(input.sessionId, null, modelVision !== false)
    // Spreadsheet query: in the chat the source is always an attachment (there is no working
    // folder), which is why ctx goes in as null.
    tools.sheet_query = createSheetQueryTool(input.sessionId, null)
    // Deliverable documents (PDF/DOCX). In the chat the scope is the sidebar
    // folder, when there is one — there is no working directory here.
    if (input.orchestrationRole !== 'worker') {
      Object.assign(
        tools,
        createDocumentAuthoringTools({ sessionId: input.sessionId }),
      )
      // Editing an attached .docx: the copy stays in Orbit, the original is not touched.
      Object.assign(tools, createDocxEditTools({ sessionId: input.sessionId }, null))
      Object.assign(tools, createPdfOpsTools({ sessionId: input.sessionId }, null))
      // Editing an image by pixel processing (resize, compress,
      // adjust tone, remove the background). In the chat the source is always the gallery — every
      // image attachment is registered there —, which is why ctx goes in as null.
      Object.assign(tools, createImageTools({ sessionId: input.sessionId }, null, imageHooks))
      // SVG and image are separate tools because their nature is different: one
      // reprocesses pixels, the other rewrites text.
      Object.assign(tools, createSvgTools({ sessionId: input.sessionId }, null))
      // In the chat the audio always comes from an attachment (there is no working folder).
      addAudioTools(null)
      // Compressing video/audio (fit under a byte ceiling, convert, extract the
      // audio). In the chat the source is always an attachment and the result goes into the
      // gallery — the image stays in image_edit, which measures itself. Without
      // ffmpeg the tool does not even exist (and the prompt does not announce it).
      if (resolveFfmpeg()) {
        Object.assign(tools, createMediaTools({ sessionId: input.sessionId, canShow: true }, null))
      }
      // Media by link (yt-dlp): download video/audio, read the transcript and, with
      // it, summarize. In the chat the file lives in Orbit's storage and goes into the
      // gallery. Without the binary installed the set does not vanish: ytdlp_install is
      // the door, and the other tools answer what to install.
      Object.assign(
        tools,
        createYtdlpTools({ sessionId: input.sessionId, canShow: true, language: input.language }, null),
      )
      // Orbit pieces (motion, design, slides): the SAME tools as code
      // mode — the piece lives in the app's storage, is addressed by name and
      // every write goes through the turn's journal. With no working folder, the
      // material comes in only through attachments, and video editing (EDL) comes along with
      // motion, reading the attachments by reference. Render only exists with the app's
      // ffmpeg.
      Object.assign(
        tools,
        createMotionTools({
          sessionId: input.sessionId,
          modelVision: modelVision !== false,
          canRender: resolveFfmpeg() !== null,
          language: input.language,
          sttEnabled: voice.stt.enabled,
        }),
      )
      Object.assign(tools, createDesignTools({ sessionId: input.sessionId }))
      Object.assign(tools, createSlidesTools({ sessionId: input.sessionId }))
      // External fonts (Orbit's library): installing does not ask permission nor
      // write to the project — the orbit-font:// scheme delivers the file to the
      // artboard and to the composition. No toggle: it exposes nothing the app does not already
      // do when rendering a font.
      Object.assign(tools, createFontTools())
    }
    if (allowBrain) Object.assign(tools, createChatMemoryTools(input))
    // Pipeline: turn what was discussed in the chat into a pipeline/task on a
    // board. Always available (not a toggle): the pipeline is another way of
    // working, not a mode of the conversation — the chat only pushes work there.
    // Workers stay out: the main session decides what becomes a task.
    if (input.orchestrationRole !== 'worker') {
      Object.assign(tools, createPipelineTools(input.sessionId, input))
      // Chat maintenance (list by inactivity, archive, delete): the basis of the
      // cleanup routines. Out of the workers for the same reason as the pipeline —
      // the main session decides what leaves the sidebar.
      Object.assign(tools, createSessionTools())
      // Past conversations: search by what was said, then read the surroundings.
      Object.assign(tools, createChatSearchTools(input))
      // Subchats: a new conversation, attached to this one, for what does not belong to this
      // context (or when a new context is worth more than another compaction).
      // Out of the workers — whoever decides to open a conversation is whoever talks to the person.
      if (win) Object.assign(tools, createSubchatTools(input, win))
      // Hours/cost report: the same math as the usage screen, so the agent can
      // answer "how many hours on project X" without guessing. Out of the workers
      // because whoever writes the report is the session that talks to the user.
      Object.assign(tools, createUsageTools())
    }
    if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
    // Vision mode: seeing the attached images is the agent's decision — the
    // describe_image tool describes on demand (with the context it passes).
    if (input.visionModel) tools.describe_image = createDescribeImageTool(input)
    // MCP servers: they are not a toggle — the tools always exist, sliced
    // by this conversation's choice (absent = all the ones on in the app).
    Object.assign(
      tools,
      getMcpTools({
        sessionId: input.sessionId,
        canShow: input.orchestrationRole !== 'worker',
        canDescribe: Boolean(input.visionModel),
        only: input.options.toolsServers,
      }),
    )
    // Explicit /create-skill flow: enables only the propose-skill tool
    if (input.orchestrationRole !== 'worker' && input.text.trimStart().startsWith('/create-skill')) {
      tools.create_skill = createSkillTool()
    }
    // MCP connections: propose a new connection, fix an existing one and read
    // the state. They only propose — the card in the conversation applies it —,
    // so they are not a toggle: they hold in any conversation, like the
    // pipeline and the chats.
    if (input.orchestrationRole !== 'worker') Object.assign(tools, createMcpTools())
    return tools
  }

  // Code mode: MCP available (configured servers) + skill flow, with the
  // conversation's slice (`toolsServers`; absent = all, which is also what
  // callers that do not go through the composer get: mobile, routines,
  // pipeline).
  // The images a server returns go to this chat's gallery; the
  // result tells the model how to show or look at them — that is why MCP
  // needs to know whether show_image and describe_image exist in this turn (the
  // conditions mirror the ones further below).
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
    // MCP connections: propose a new connection, fix an existing one and read the
    // state. They only propose — what applies it is the card in the conversation.
    Object.assign(tools, createMcpTools())
    // Artifacts in code mode too: an analysis report, an architecture
    // diagram, a comparison — things the user wants to SEE and that should not
    // become a loose file in their repository.
    Object.assign(tools, createArtifactTools(input.sessionId))
    // What is open in the panel (the read_open_panel tool) — holds in both modes.
    Object.assign(tools, createPanelTools(input.sessionId))
  }
  // Attached documents in code mode too: `read`/`grep` reach the
  // repository, not what the user dragged into the conversation. Without this, the
  // opening excerpt of the attachment would point to a nonexistent tool.
  Object.assign(tools, createDocumentTools(input.sessionId))
  tools.pdf_view_page = createPdfViewTool(input.sessionId, ctx, ctx?.modelVision !== false)
  // In code mode the query reaches both sources: a spreadsheet from the repository
  // (filePath, via ctx) and a spreadsheet attached to the conversation (docId).
  tools.sheet_query = createSheetQueryTool(input.sessionId, ctx)
  // In code mode the scope is the REPOSITORY: list_documents finds again what was
  // produced over the same working folder in any earlier conversation,
  // not just in this session.
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
    // In code mode the image can also come from the working folder (a project
    // asset), so here ctx goes in — and with it savePath, to write the
    // edited version back into the repository when the user asks.
    Object.assign(
      tools,
      createImageTools({ sessionId: input.sessionId, directory: input.directory }, ctx, imageHooks),
    )
    Object.assign(
      tools,
      createSvgTools({ sessionId: input.sessionId, directory: input.directory }, ctx),
    )
    // In code mode the audio can also be a file from the folder (and the generated one can
    // be written there).
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
    // Symbol index: finds the right excerpt (file:line + code + who
    // uses it) in one call, instead of the grep → read → read round.
    Object.assign(tools, createCodeTools(ctx))
    tools.todowrite = createTodoTool()
    // Reading the turn state: verify_changes checks what was written;
    // session_context brings metadata of recent turns. Both are reads
    // (fine in plan) and get no extra guidance in the prompt — the model
    // decides when to call them.
    tools.verify_changes = createVerifyChangesTool(ctx)
    tools.session_context = createSessionContextTool(ctx)
    if (!input.options.plan) {
      tools.write = createWriteTool(ctx)
      tools.edit = createEditTool(ctx)
      tools.bash = createBashTool(ctx)
      Object.assign(tools, createBackgroundTools(ctx))
    }
  }
  // Video editing (EDL): needs a folder (the outputs go to edit/ next to
  // the material) and the ffmpeg that comes with the app. Workers get in, but do not
  // show a player: whoever talks to the user is the main session.
  if (ctx && resolveFfmpeg()) {
    Object.assign(
      tools,
      createVideoTools(ctx, {
        sessionId: input.sessionId,
        canShow: input.orchestrationRole !== 'worker',
        readOnly: Boolean(input.options.plan),
        language: input.language,
        // With "Speech to text" off the engine does not transcribe: the tool does not even appear
        // and the prompt (AUDIO_TRANSCRIBE_OFF) says where to turn it on.
        sttEnabled: voice.stt.enabled,
      }),
    )
    // Media compression: uses the same ffmpeg and the same material as video, but
    // it is another task — it fits in plan, because it writes a NEW file in media/
    // and never touches the source.
    Object.assign(
      tools,
      createMediaTools({ sessionId: input.sessionId, canShow: input.orchestrationRole !== 'worker' }, ctx),
    )
  }
  // Media by link (yt-dlp): depends on a folder, not on ffmpeg — the audio and the
  // subtitles work without it, and the video merge uses the app's ffmpeg when
  // it exists. It stays out of the block above so it does not vanish on a system without ffmpeg.
  if (ctx) {
    Object.assign(
      tools,
      createYtdlpTools(
        { sessionId: input.sessionId, canShow: input.orchestrationRole !== 'worker', language: input.language },
        ctx,
      ),
    )
  }
  // Orbit pieces (motion, design, slides): the SAME tools as the chat. The piece
  // lives in the app's storage, not in the repository — the project comes in as a
  // SOURCE of material (the *_asset ones with `path`) and as a destination only when the
  // user asks (piece_export, motion_render with `output`). That way every
  // write goes through the turn's journal and the message's revert undoes it.
  if (ctx) {
    const plan = Boolean(input.options.plan)
    const isWorker = input.orchestrationRole === 'worker'
    // Motion also gets into the workers — the skill says to make each animation in a
    // sub-agent in parallel —, but without opening a tab: the panel belongs to the main
    // session, which shows the piece by the id the worker returns.
    Object.assign(
      tools,
      createMotionTools({
        sessionId: input.sessionId,
        project: ctx,
        modelVision: ctx.modelVision !== false,
        canRender: resolveFfmpeg() !== null,
        canShow: !isWorker,
        readOnly: plan,
        language: input.language,
        sttEnabled: voice.stt.enabled,
      }),
    )
    // Design and slides: main session only — the panel is a visible resource.
    if (!isWorker) {
      Object.assign(tools, createDesignTools({ sessionId: input.sessionId, project: ctx, readOnly: plan }))
      Object.assign(tools, createSlidesTools({ sessionId: input.sessionId, project: ctx, readOnly: plan }))
      if (!plan) tools.piece_export = createPieceExportTool(ctx, { sessionId: input.sessionId })
      Object.assign(tools, createFontTools())
    }
  }

  // Right panel browser: testing web apps + documentation mode.
  // Workers stay out — the panel is a single, visible resource. With the
  // browser tools off in Preferences, only when the request
  // came from the full-screen browser itself (see agentMayUseBrowser).
  if (ctx && input.orchestrationRole !== 'worker') {
    const panelTools = createPanelBrowserTools(ctx)
    if (agentMayUseBrowser(input)) {
      Object.assign(tools, panelTools)
      // Batch automation: runs in a hidden window, without competing for the panel.
      Object.assign(tools, createBrowserScriptTools(ctx))
      // Recording a script to video (same hidden window, capture via CDP).
      // It does not ask permission and does not open a window — but it should only be called when
      // the user asks for a recording (see the tool's description).
      Object.assign(tools, createBrowserRecordTools(ctx))
    } else {
      // show_image also shows images from the project and the gallery — that is not
      // using the browser, so it stays.
      tools.show_image = panelTools.show_image
    }
  }
  if (allowBrain && ctx) {
    Object.assign(tools, createCodeMemoryTools(input, ctx))
    tools.memory_graph = createGraphTool(input, ctx)
  }
  if (input.orchestrationRole !== 'worker') {
    Object.assign(tools, createPipelineTools(input.sessionId, input))
    // Chat maintenance (list by inactivity, archive, delete): the basis of the
    // cleanup routines. Out of the workers for the same reason as the pipeline —
    // the main session decides what leaves the sidebar.
    Object.assign(tools, createSessionTools())
    Object.assign(tools, createChatSearchTools(input))
    // Subchats: a new conversation, attached to this one, for what does not belong to this
    // context (or when a new context is worth more than another compaction).
    // Out of the workers — whoever decides to open a conversation is whoever talks to the person.
    if (win) Object.assign(tools, createSubchatTools(input, win))
    Object.assign(tools, createUsageTools())
    // Worktrees: switching the chat's folder is the main session's decision — a
    // worker changing the folder of whoever called it would derail the conversation.
    if (ctx) Object.assign(tools, createWorktreeTools(ctx))
  }
  if (allowQuestion) tools.question = createQuestionTool(input, ctx?.abort)
  if (allowDelegation) tools.subagent = createSubagentTool(input, ctx)
  // Vision mode: seeing the attached images is the agent's decision — the
  // describe_image tool describes on demand (with the context it passes).
  if (input.visionModel) tools.describe_image = createDescribeImageTool(input)
  // Programmatic Tool Calling: one script instead of N round trips. It goes LAST
  // because it reads the assembled set (the script's API) on every run. Code mode
  // only, and never in plan: the sandbox is hermetic, but a script that reached the
  // host realm would still write around a read-only turn. Workers stay out — their
  // loop already runs on a short context, which is the problem this solves.
  if (ctx && !input.options.plan && input.orchestrationRole !== 'worker') {
    tools.run_tools = createRunToolsTool({ input, ctx, tools: () => tools })
  }

  return tools
}
