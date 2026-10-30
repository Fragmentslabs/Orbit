import { readAppLanguage } from './app-language'

/**
 * Main-process i18n.
 *
 * The renderer translates its own UI with i18next, but the main process also
 * produces text the user reads outside it: titles and bodies of the native
 * notifications (pending question/permission, finished message, chat error,
 * routine). Before this it only knew Portuguese, so an English app received a
 * Portuguese banner.
 *
 * The language is the same one the renderer publishes in `app:setLanguage`
 * (language name in English, e.g.: "Portuguese") — the value the routine
 * scheduler already uses for the prompts. The renderer publishes it on boot and
 * on every switch, so mirroring it here is enough: `setMainLocale` in the IPC
 * handler and `loadMainLocale` on boot.
 *
 * Only fixed product sentences enter here. Content text (session title,
 * response preview, raw provider message) is not translated: it is data.
 */

/** Languages the app speaks. Mirrors the renderer's locales (src/i18n/locales). */
export type MainLocale = 'pt-BR' | 'en'

/**
 * Fixed main-process sentences. Flat keys with a dot: the consumer asks for
 * `t('notif.chatError.title')` and the `MainMessageKey` type refuses a nonexistent key.
 * Exported so the test can check that both languages cover every key.
 */
export const MESSAGES = {
  // ── Pending question/permission ───────────────────────────────────────────
  'notif.question.title': {
    'pt-BR': 'Pergunta do Orbit',
    en: 'Orbit question',
  },
  'notif.question.pendingIn': {
    'pt-BR': 'Pergunta pendente em {{session}}',
    en: 'Pending question in {{session}}',
  },
  'notif.permission.title': {
    'pt-BR': 'Permissão necessária',
    en: 'Permission required',
  },
  'notif.permission.fallback': {
    'pt-BR': 'o agente quer executar uma ação',
    en: 'the agent wants to run an action',
  },
  'notif.pending.question': {
    'pt-BR': 'pergunta pendente',
    en: 'pending question',
  },
  'notif.pending.action': {
    'pt-BR': 'ação pendente',
    en: 'pending action',
  },
  'notif.batch.more': {
    'pt-BR': '(+{{count}} mais)',
    en: '(+{{count}} more)',
  },

  // ── Chat error ──────────────────────────────────────────────────────────
  'notif.chatError.title': {
    'pt-BR': 'Erro no chat',
    en: 'Chat error',
  },
  'notif.chatError.unexpected': {
    'pt-BR': 'erro inesperado',
    en: 'unexpected error',
  },
  // Short reason per failure type — the card in the app brings the full explanation
  // (renderer i18n, chat.errorKind.*) and the provider's raw text.
  'notif.chatError.kind.moderation': {
    'pt-BR': 'o filtro de conteúdo do provedor bloqueou a resposta — troque de modelo',
    en: 'the provider blocked this reply with its content filter — switch models',
  },
  'notif.chatError.kind.model-unavailable': {
    'pt-BR': 'o provedor não serve o modelo selecionado — escolha outro modelo',
    en: 'this provider does not serve the selected model — pick another one',
  },
  'notif.chatError.kind.rate-limit': {
    'pt-BR': 'limite de uso do provedor atingido — aguarde ou troque de modelo',
    en: 'provider usage limit reached — wait a bit or switch models',
  },
  'notif.chatError.kind.network': {
    'pt-BR': 'falha de rede ao falar com o provedor — tente novamente',
    en: 'network failure talking to the provider — try again',
  },
  'notif.chatError.kind.context-length': {
    'pt-BR': 'a conversa passou da janela de contexto do modelo — compacte o histórico',
    en: 'the conversation outgrew the model context window — compact the history',
  },
  'notif.chatError.kind.context-length-turn': {
    'pt-BR': 'o trabalho desta resposta passou da janela de contexto — peça para continuar',
    en: 'the work in this reply outgrew the context window — ask it to continue',
  },
  'notif.chatError.kind.provider-config': {
    'pt-BR': 'o provedor não está configurado — verifique as Configurações',
    en: 'the provider is not configured — check Settings',
  },
  'notif.chatError.kind.tool-limit': {
    'pt-BR': 'o provedor recusou o pedido por excesso de ferramentas — o catálogo corta as menos usadas e vale na próxima',
    en: 'the provider rejected the request for having too many tools — the catalog drops the least used ones for the next try',
  },

  // ── Scheduled routines ────────────────────────────────────────────────────
  'notif.routine.done': {
    'pt-BR': 'Rotina concluída',
    en: 'Routine finished',
  },
  'notif.routine.doneWithCost': {
    'pt-BR': 'Rotina concluída — US$ {{cost}}',
    en: 'Routine finished — US$ {{cost}}',
  },
  'notif.routine.failed': {
    'pt-BR': 'Rotina falhou: {{error}}',
    en: 'Routine failed: {{error}}',
  },
  'notif.routine.unknownError': {
    'pt-BR': 'erro desconhecido',
    en: 'unknown error',
  },
  // ── Site permissions in the built-in browser ──────────────────────────────
  'browserPerm.title': {
    'pt-BR': '{{site}} quer acessar',
    en: '{{site}} wants to use',
  },
  'browserPerm.detail': {
    'pt-BR': 'Pedido do site aberto no navegador do Orbit: {{what}}.',
    en: 'Request from the site open in the Orbit browser: {{what}}.',
  },
  'browserPerm.allow': {
    'pt-BR': 'Permitir',
    en: 'Allow',
  },
  'browserPerm.block': {
    'pt-BR': 'Bloquear',
    en: 'Block',
  },
  'browserPerm.cancel': {
    'pt-BR': 'Cancelar',
    en: 'Cancel',
  },
  'browserPerm.remember': {
    'pt-BR': 'Lembrar para este site',
    en: 'Remember for this site',
  },
  'browserPerm.camera': {
    'pt-BR': 'câmera',
    en: 'camera',
  },
  'browserPerm.microphone': {
    'pt-BR': 'microfone',
    en: 'microphone',
  },
  'browserPerm.geolocation': {
    'pt-BR': 'localização',
    en: 'location',
  },
  'browserPerm.notifications': {
    'pt-BR': 'notificações',
    en: 'notifications',
  },
  'browserPerm.clipboard': {
    'pt-BR': 'leitura da área de transferência',
    en: 'clipboard reading',
  },
  'browserPerm.midi': {
    'pt-BR': 'dispositivos MIDI',
    en: 'MIDI devices',
  },
  'browserPerm.systemDenied.title': {
    'pt-BR': 'O macOS bloqueou o acesso do Orbit ao {{what}}',
    en: 'macOS blocked Orbit from using the {{what}}',
  },
  'browserPerm.systemDenied.detail': {
    'pt-BR': 'Libere o Orbit em Ajustes do Sistema › Privacidade e Segurança › {{what}} e recarregue a página.',
    en: 'Allow Orbit in System Settings › Privacy & Security › {{what}} and reload the page.',
  },
  'browserPerm.systemDenied.open': {
    'pt-BR': 'Abrir Ajustes',
    en: 'Open Settings',
  },
  'browserPerm.screen.title': {
    'pt-BR': '{{site}} quer compartilhar sua tela',
    en: '{{site}} wants to share your screen',
  },
  'browserPerm.screen.detail': {
    'pt-BR': 'A tela principal será compartilhada com o site aberto no navegador do Orbit.',
    en: 'Your main screen will be shared with the site open in the Orbit browser.',
  },
  // ── System tray ────────────────────────────────────────────────────
  'tray.open': {
    'pt-BR': 'Abrir o Orbit',
    en: 'Open Orbit',
  },
  'tray.quit': {
    'pt-BR': 'Fechar o Orbit',
    en: 'Quit Orbit',
  },
  'tray.tooltip': {
    'pt-BR': 'Orbit — clique para abrir',
    en: 'Orbit — click to open',
  },

  // ── /init result (assistant message in the chat) ───────────────────
  'init.unfinished': {
    'pt-BR': '_O coordenador parou sem confirmar a revisão final; o rascunho estava consistente e foi gravado como estava._',
    en: '_The coordinator stopped without confirming the final review; the draft was consistent and was saved as it was._',
  },
  'init.nothing.title': {
    'pt-BR': '## Nada para memorizar',
    en: '## Nothing to memorize',
  },
  'init.nothing.body': {
    'pt-BR': 'A análise não encontrou nada específico o bastante para valer uma memória.',
    en: 'The analysis found nothing specific enough to be worth a memory.',
  },
  'init.count.created': {
    'pt-BR': '{{count}} nova(s)',
    en: '{{count}} new',
  },
  'init.count.updated': {
    'pt-BR': '{{count}} atualizada(s)',
    en: '{{count}} updated',
  },
  'init.count.retired': {
    'pt-BR': '{{count}} antiga(s) removida(s)',
    en: '{{count}} old removed',
  },
  'init.count.learnings': {
    'pt-BR': '{{count}} aprendizado(s) para outros projetos',
    en: '{{count}} learning(s) for other projects',
  },
  'init.saved.title': {
    'pt-BR': '## Projeto memorizado',
    en: '## Project memorized',
  },
  'init.saved.tree': {
    'pt-BR': 'Árvore gravada ({{counts}})',
    en: 'Tree saved ({{counts}})',
  },
  'init.saved.footer': {
    'pt-BR':
      'Todo chat novo nesta pasta, ou numa subpasta dela, começa com o mapa dessa árvore e abre os detalhes conforme a tarefa. Dá para ver e editar tudo na aba Memórias.',
    en: 'Every new chat in this folder, or in one of its subfolders, starts with the map of this tree and opens the details as the task needs. You can see and edit everything in the Memories tab.',
  },
  'init.cancelled': {
    'pt-BR':
      '## Análise cancelada\n\nNada foi gravado: as memórias só são salvas no fim, depois que a árvore inteira é revisada. Rode `/init` de novo quando quiser.',
    en: '## Analysis cancelled\n\nNothing was saved: memories are only written at the end, after the whole tree is reviewed. Run `/init` again whenever you want.',
  },
  'init.failed.title': {
    'pt-BR': '## Análise falhou',
    en: '## Analysis failed',
  },
  'init.failed.nothingSaved': {
    'pt-BR': 'Nada foi gravado.',
    en: 'Nothing was saved.',
  },

  // ── Panel browser activity feed ────────────────────────────────
  'panel.activity.resize': {
    'pt-BR': 'Redimensionando para {{label}}',
    en: 'Resizing to {{label}}',
  },
  'panel.activity.navigate': {
    'pt-BR': 'Navegando para {{url}}',
    en: 'Navigating to {{url}}',
  },
  'panel.activity.read': {
    'pt-BR': 'Lendo a página',
    en: 'Reading the page',
  },
  'panel.activity.click': {
    'pt-BR': 'Clicando em {{target}}',
    en: 'Clicking {{target}}',
  },
  'panel.activity.type': {
    'pt-BR': 'Digitando…',
    en: 'Typing…',
  },
  'panel.activity.screenshot': {
    'pt-BR': 'Capturando a tela',
    en: 'Capturing the screen',
  },
  'panel.activity.eval': {
    'pt-BR': 'Executando JavaScript na página',
    en: 'Running JavaScript on the page',
  },
  'panel.activity.hover': {
    'pt-BR': 'Passando o mouse',
    en: 'Hovering',
  },
  'panel.activity.drag': {
    'pt-BR': 'Arrastando',
    en: 'Dragging',
  },
  'panel.activity.dragHold': {
    'pt-BR': 'Arrastando (segurando)',
    en: 'Dragging (holding)',
  },
  'panel.activity.scriptOpen': {
    'pt-BR': 'Script: abrindo {{url}}',
    en: 'Script: opening {{url}}',
  },
  'panel.activity.scriptCapture': {
    'pt-BR': 'Script: capturando {{name}}',
    en: 'Script: capturing {{name}}',
  },
  'panel.activity.recordStart': {
    'pt-BR': 'Gravando {{url}}',
    en: 'Recording {{url}}',
  },
  'panel.activity.recordStep': {
    'pt-BR': 'Gravando: {{label}}',
    en: 'Recording: {{label}}',
  },
  'panel.activity.recordSave': {
    'pt-BR': 'Codificando o vídeo da gravação',
    en: 'Encoding the recording',
  },
  'panel.activity.fullPage': {
    'pt-BR': 'Capturando a página inteira',
    en: 'Capturing the full page',
  },

  // ── Conversation sources (errors returned to the UI) ─────────────────────
  'sources.error.noFileToPrint': {
    'pt-BR': 'Este tipo de fonte não tem arquivo para imprimir.',
    en: 'This kind of source has no file to print.',
  },
  'sources.error.onlyPdfPrint': {
    'pt-BR': 'Só PDF pode ser impresso daqui. Baixe o arquivo e imprima pelo Word.',
    en: 'Only PDFs can be printed from here. Download the file and print it from Word.',
  },
  'sources.error.notFound': {
    'pt-BR': 'Documento não encontrado.',
    en: 'Document not found.',
  },
  'sources.error.unsupportedKind': {
    'pt-BR': '{{filename}}: só PDF, DOCX e planilhas entram como fonte.',
    en: '{{filename}}: only PDF, DOCX and spreadsheets can be added as sources.',
  },
  'sources.error.emptyText': {
    'pt-BR': 'O texto está vazio.',
    en: 'The text is empty.',
  },
  'sources.error.noReadableText': {
    'pt-BR': '{{url}}: a página não trouxe texto legível (pode depender de JavaScript).',
    en: '{{url}}: the page returned no readable text (it may depend on JavaScript).',
  },
  'sources.error.invalidId': {
    'pt-BR': 'Id inválido.',
    en: 'Invalid id.',
  },
  'sources.error.noFolder': {
    'pt-BR': 'Esta conversa não está em nenhuma pasta, então não há com quem compartilhar.',
    en: 'This conversation is not in any folder, so there is nothing to share it with.',
  },
  'sources.defaultFileName': {
    'pt-BR': 'documento',
    en: 'document',
  },
  // ── Computer Use: strip at the top of the screen while the agent controls an app ──
  'computer.overlay': {
    'pt-BR': 'Orbit está controlando {{apps}}',
    en: 'Orbit is controlling {{apps}}',
  },
  'computer.overlayGlobal': {
    'pt-BR': 'Orbit está usando o seu mouse em {{apps}} — não mexa',
    en: 'Orbit is using your mouse in {{apps}} — hands off',
  },
  'computer.overlayStop': {
    'pt-BR': 'Parar',
    en: 'Stop',
  },

  // ── Default session titles ────────────────────────────────────────────────
  // Written into the session on creation (companion-server), so they are data:
  // `isDefaultTitle` has to recognise what each language produced.
  'chat.defaultTitle.chat': {
    'pt-BR': 'Nova conversa',
    en: 'New chat',
  },
  'chat.defaultTitle.code': {
    'pt-BR': 'Nova sessão de código',
    en: 'New code session',
  },

  // ── Companion WebSocket server (errors the mobile app shows) ─────────────
  'companion.server.notAuthenticated': {
    'pt-BR': 'Não autenticado',
    en: 'Not authenticated',
  },
  'companion.server.noMainWindow': {
    'pt-BR': 'Janela principal indisponível',
    en: 'Main window unavailable',
  },
  'companion.server.sessionNotFound': {
    'pt-BR': 'Sessão não encontrada',
    en: 'Session not found',
  },
  'companion.server.sessionWithoutFolder': {
    'pt-BR': 'Sessão sem diretório',
    en: 'Session without a folder',
  },
  'companion.server.noDesktopWindow': {
    'pt-BR': 'Nenhuma janela do desktop aberta',
    en: 'No desktop window open',
  },
  'companion.server.revertFailed': {
    'pt-BR': 'Não foi possível reverter',
    en: 'Could not revert',
  },
  'companion.server.nothingToRevert': {
    'pt-BR': 'Nada para reverter',
    en: 'Nothing to revert',
  },
  'companion.server.nothingToUndo': {
    'pt-BR': 'Nada para desfazer',
    en: 'Nothing to undo',
  },
  'companion.server.memoryNotFound': {
    'pt-BR': 'Memória não encontrada',
    en: 'Memory not found',
  },
  'companion.server.memoryCannotPromote': {
    'pt-BR': 'Memória não pode ser promovida',
    en: 'Memory cannot be promoted',
  },
  'companion.server.listFailed': {
    'pt-BR': 'Não foi possível listar: {{error}}',
    en: 'Could not list: {{error}}',
  },
  'companion.server.pipelineNotFound': {
    'pt-BR': 'Pipeline não encontrada',
    en: 'Pipeline not found',
  },
  'companion.server.projectNotFound': {
    'pt-BR': 'Projeto não encontrado',
    en: 'Project not found',
  },
  'companion.server.taskNotFound': {
    'pt-BR': 'Task não encontrada',
    en: 'Task not found',
  },

  // ── Companion HTTP API (errors the mobile app shows) ────────────────────
  'companion.http.invalidJson': {
    'pt-BR': 'JSON inválido',
    en: 'Invalid JSON',
  },
  'companion.http.invalidToken': {
    'pt-BR': 'Token inválido ou expirado',
    en: 'Invalid or expired token',
  },
  'companion.http.invalidPin': {
    'pt-BR': 'PIN inválido ou ausente',
    en: 'Invalid or missing PIN',
  },
  'companion.http.providerAndModelRequired': {
    'pt-BR': 'providerId e modelId são obrigatórios',
    en: 'providerId and modelId are required',
  },
  'companion.http.nameAndContentRequired': {
    'pt-BR': 'name e content são obrigatórios',
    en: 'name and content are required',
  },
  'companion.http.contentAndFilenameRequired': {
    'pt-BR': 'content (base64) e filename são obrigatórios',
    en: 'content (base64) and filename are required',
  },
  'companion.http.repoAndBranchRequired': {
    'pt-BR': 'repoPath e branch obrigatórios',
    en: 'repoPath and branch are required',
  },
  'companion.http.pcmRequired': {
    'pt-BR': 'pcm (base64) é obrigatório',
    en: 'pcm (base64) is required',
  },
  'companion.http.invalidSampleRate': {
    'pt-BR': 'sampleRate deve ser um número positivo (Hz)',
    en: 'sampleRate must be a positive number (Hz)',
  },
  'companion.http.invalidPcm': {
    'pt-BR': 'pcm vazio ou base64 inválido',
    en: 'empty pcm or invalid base64',
  },
  'companion.http.invalidSlug': {
    'pt-BR': 'Slug inválido — use apenas letras minúsculas, números e underscores',
    en: 'Invalid slug — use only lowercase letters, digits and underscores',
  },
  'companion.http.invalidSlugShort': {
    'pt-BR': 'Slug inválido',
    en: 'Invalid slug',
  },
  'companion.http.voiceUnavailable': {
    'pt-BR': 'Voz indisponível',
    en: 'Voice unavailable',
  },
  'companion.http.imageNotFound': {
    'pt-BR': 'Imagem não encontrada',
    en: 'Image not found',
  },
  'companion.http.fileNotFound': {
    'pt-BR': 'Arquivo não encontrado',
    en: 'File not found',
  },
  'companion.http.internalError': {
    'pt-BR': 'Erro interno',
    en: 'Internal error',
  },
  'companion.http.endpointNotFound': {
    'pt-BR': 'Endpoint não encontrado',
    en: 'Endpoint not found',
  },

  // ── Permission claims ───────────────────────────────────────────────────
  'perm.control.plain': {
    'pt-BR': 'Controlar {{app}}',
    en: 'Control {{app}}',
  },
  'perm.control.withHost': {
    'pt-BR': 'Controlar {{app}} em {{host}}',
    en: 'Control {{app}} on {{host}}',
  },
  'perm.bringToFront': {
    'pt-BR': 'abrir / trazer para a frente',
    en: 'open / bring to front',
  },
  'perm.batchCount': {
    'pt-BR': '{{count}} ações em sequência',
    en: '{{count}} actions in a row',
  },
  'perm.approvalThisApp': {
    'pt-BR': 'A aprovação vale para este app',
    en: 'The approval applies to this app',
  },
  'perm.approvalAllTabs': {
    'pt-BR':
      ' Atenção: o site desta aba não pôde ser lido, então a aprovação vale para TODAS as abas deste navegador.',
    en: " Warning: this tab's site could not be read, so the approval applies to ALL tabs of this browser.",
  },
  'perm.risk.elevated': {
    'pt-BR': 'comando com privilégios elevados (sudo)',
    en: 'command with elevated privileges (sudo)',
  },
  'perm.risk.recursiveRemoveOutside': {
    'pt-BR': 'remoção recursiva fora do projeto ou da raiz',
    en: 'recursive removal outside the project or the root',
  },
  'perm.risk.recursiveRemove': {
    'pt-BR': 'remoção recursiva de arquivos (rm -rf)',
    en: 'recursive file removal (rm -rf)',
  },
  'perm.risk.forcePush': {
    'pt-BR': 'push forçado reescreve histórico remoto',
    en: 'force push rewrites remote history',
  },
  'perm.risk.hardReset': {
    'pt-BR': 'descarta alterações locais (git reset --hard)',
    en: 'discards local changes (git reset --hard)',
  },
  'perm.risk.osascript': {
    'pt-BR': 'controla outros apps pela interface (osascript/System Events)',
    en: 'controls other apps through the UI (osascript/System Events)',
  },
  'perm.risk.powershell': {
    'pt-BR': 'controla outros apps pela interface (PowerShell/UI Automation)',
    en: 'controls other apps through the UI (PowerShell/UI Automation)',
  },
  'perm.risk.dependencies': {
    'pt-BR': 'instalação/remoção de dependências',
    en: 'installing/removing dependencies',
  },
  'perm.risk.gitWrite': {
    'pt-BR': 'escrita dentro de .git corrompe o repositório',
    en: 'writing inside .git corrupts the repository',
  },
  'perm.risk.envFile': {
    'pt-BR': 'arquivo de segredos/ambiente (.env)',
    en: 'secrets/environment file (.env)',
  },
  'perm.risk.lockfile': {
    'pt-BR': 'lockfile de dependências',
    en: 'dependency lockfile',
  },
  'perm.worktree.remove': {
    'pt-BR': 'Remover o worktree {{name}}',
    en: 'Remove the worktree {{name}}',
  },
  'perm.worktree.removeDetail': {
    'pt-BR': 'Apaga a pasta do worktree — alterações não commitadas nela são perdidas.',
    en: 'Deletes the worktree folder — uncommitted changes in it are lost.',
  },
  'perm.worktree.branchDeleted': {
    'pt-BR': ' O branch dele também é apagado.',
    en: ' Its branch is deleted too.',
  },
  'perm.worktree.branchKept': {
    'pt-BR': ' O branch é mantido.',
    en: ' The branch is kept.',
  },
  'perm.subchat.sendInstruction': {
    'pt-BR': 'Enviar uma instrução a um subchat',
    en: 'Send an instruction to a subchat',
  },
  'perm.mcp.tool': {
    'pt-BR': 'Ferramenta do servidor MCP "{{server}}"',
    en: 'Tool from the MCP server "{{server}}"',
  },

  // ── Providers (errors shown in Settings) ────────────────────────────────
  'provider.invalidId': {
    'pt-BR': 'ID inválido: use letras, números, "-" e "_" (sem espaços).',
    en: 'Invalid ID: use letters, digits, "-" and "_" (no spaces).',
  },
  'provider.nameRequired': {
    'pt-BR': 'Informe um nome para o provedor.',
    en: 'Enter a name for the provider.',
  },
  'provider.idExists': {
    'pt-BR': 'Já existe um provedor com o ID "{{id}}".',
    en: 'A provider with the ID "{{id}}" already exists.',
  },
  'provider.notFound': {
    'pt-BR': 'Provedor não encontrado.',
    en: 'Provider not found.',
  },
  'provider.notFoundWithId': {
    'pt-BR': 'Provedor "{{id}}" não encontrado.',
    en: 'Provider "{{id}}" not found.',
  },
  'provider.noBaseUrl': {
    'pt-BR': 'O provedor não tem URL base configurada.',
    en: 'The provider has no base URL configured.',
  },
  'provider.listModelsFailed': {
    'pt-BR': 'Não foi possível listar os modelos do servidor.',
    en: 'Could not list the server models.',
  },

  // ── Voice model status ──────────────────────────────────────────────────
  'voice.status.downloading': {
    'pt-BR': 'baixando…',
    en: 'downloading…',
  },
  'voice.status.extracting': {
    'pt-BR': 'extraindo o pacote…',
    en: 'extracting the package…',
  },
  'voice.status.extractFailed': {
    'pt-BR': 'falha ao extrair o pacote',
    en: 'failed to extract the package',
  },
  'voice.status.notExtracted': {
    'pt-BR': 'o pacote está baixado; falta extrair (e baixar o VAD Silero) antes de usar',
    en: 'the package is downloaded; it still has to be extracted (and the Silero VAD fetched) before use',
  },
  'voice.status.partial': {
    'pt-BR': 'download incompleto ({{received}} de {{total}} bytes)',
    en: 'incomplete download ({{received}} of {{total}} bytes)',
  },
  'voice.status.absent': {
    'pt-BR': 'ainda não foi baixado',
    en: 'not downloaded yet',
  },

  // ── Generated document previews ─────────────────────────────────────────
  'media.previewUnavailable': {
    'pt-BR': '(pré-visualização indisponível)',
    en: '(preview unavailable)',
  },
  'media.morePages': {
    'pt-BR': '… {{count}} página(s) a mais — baixe o PDF para ver o documento inteiro.',
    en: '… {{count}} more page(s) — download the PDF to see the whole document.',
  },

  // ── Voice hardware recommendation (Settings → Voice) ────────────────────
  'voice.hardware.sherpaMissing': {
    'pt-BR':
      'Sem binário do sherpa-onnx para {{platform}}/{{arch}}: o Parakeet não roda aqui, então a recomendação é o whisper ({{arch}} fora de x64/arm64 ou sistema não coberto).',
    en: 'No sherpa-onnx binary for {{platform}}/{{arch}}: Parakeet does not run here, so the recommendation is whisper ({{arch}} outside x64/arm64 or an uncovered system).',
  },
  'voice.hardware.lowRam': {
    'pt-BR':
      'A máquina tem {{gb}} GB de RAM: o Parakeet carrega ~{{need}} GB em memória, então vale um modelo de whisper menor para não pesar.',
    en: 'This machine has {{gb}} GB of RAM: Parakeet loads ~{{need}} GB into memory, so a smaller whisper model is worth it to keep things light.',
  },
  'voice.hardware.parakeetReady': {
    'pt-BR':
      'Parakeet TDT 0.6B v3 em CPU pelo sherpa-onnx: binário pronto para {{platform}}/{{arch}}, sem compilar nada, e a máquina tem {{gb}} GB de RAM para os ~{{need}} GB que ele carrega.',
    en: 'Parakeet TDT 0.6B v3 on CPU through sherpa-onnx: binary ready for {{platform}}/{{arch}}, nothing to compile, and the machine has {{gb}} GB of RAM for the ~{{need}} GB it loads.',
  },
  'voice.hardware.lowMemoryWarning': {
    'pt-BR':
      'Memória baixa: {{gb}} GB. Com o Parakeet carregado o processo cresce ~{{need}} GB — em máquina de 8 GB isso trava o resto do app.',
    en: 'Low memory: {{gb}} GB. With Parakeet loaded the process grows ~{{need}} GB — on an 8 GB machine that stalls the rest of the app.',
  },
  'voice.hardware.fewCpus': {
    'pt-BR':
      'Só {{cpus}} núcleo(s) de CPU: use 2 threads no ditado (acima disso a inferência não melhora e o app fica sem folga).',
    en: 'Only {{cpus}} CPU core(s): use 2 dictation threads (beyond that inference does not improve and the app runs out of headroom).',
  },
  'voice.hardware.macIntel': {
    'pt-BR': 'macOS em x64 (Intel): o Parakeet roda em CPU, bem mais devagar que no Apple Silicon.',
    en: 'macOS on x64 (Intel): Parakeet runs on CPU, far slower than on Apple Silicon.',
  },
  'voice.hardware.windowsPreview': {
    'pt-BR':
      'No Windows as APIs de voz novas do sistema estão em preview e só aceitam inglês — por isso o app leva o próprio modelo.',
    en: 'On Windows the new system speech APIs are in preview and only accept English — that is why the app ships its own model.',
  },
  'voice.hardware.macos26': {
    'pt-BR':
      'No macOS 26 existiria o reconhecedor de fala do próprio sistema; aqui os motores do app são só parakeet e whisper.',
    en: 'On macOS 26 the system has its own speech recognizer; here the app engines are only parakeet and whisper.',
  },
  'voice.hardware.linuxNoEngine': {
    'pt-BR': 'No Linux não há motor de fala no sistema: o modelo é sempre o do app.',
    en: 'On Linux there is no system speech engine: the model is always the app one.',
  },
  'voice.hardware.notDownloaded': {
    'pt-BR':
      'O modelo recomendado ({{model}}) ainda não está baixado — baixe em Configurações → Voz (~{{mb}} MB).',
    en: 'The recommended model ({{model}}) is not downloaded yet — download it in Settings → Voice (~{{mb}} MB).',
  },

  // ── Orchestrator messages shown in the chat ─────────────────────────────
  'orchestrator.stepsExhausted': {
    'pt-BR':
      'O orçamento de passos do planejamento acabou antes de eu conseguir responder e não registrei nenhuma tarefa. Diga "continue" que eu retomo de onde parei — ou me diga se prefere que eu divida o trabalho em tarefas.',
    en: 'The planning step budget ran out before I could answer and I registered no task. Say "continue" and I will pick up where I stopped — or tell me if you would rather I split the work into tasks.',
  },
  'orchestrator.planGone': {
    'pt-BR':
      'Este plano não está mais disponível para execução (o app foi reiniciado?). Envie o pedido novamente.',
    en: 'This plan is no longer available for execution (did the app restart?). Send the request again.',
  },
} as const satisfies Record<string, Record<MainLocale, string>>

export type MainMessageKey = keyof typeof MESSAGES

/** Language held in memory — avoids re-reading the storage on every sentence of a notification. */
let cached: MainLocale | undefined

/** "Portuguese"/"pt-BR"/"pt" → pt-BR; anything else (including empty) → en. */
export function resolveMainLocale(language: string | undefined): MainLocale {
  const value = (language ?? '').trim().toLowerCase()
  return value.startsWith('pt') || value.startsWith('portuguese') ? 'pt-BR' : 'en'
}

/** The language already in memory (without reading the storage) — for whoever cannot wait,
 *  such as speech that needs a fallback language. */
export function currentMainLocale(): MainLocale | undefined {
  return cached
}

/** Mirrors the language published by the renderer (`app:setLanguage`). */
export function setMainLocale(language: string): void {
  cached = resolveMainLocale(language)
}

/**
 * Loads the persisted language — called at boot and, on demand, on the first
 * sentence of each notification. It never throws: `t()` runs on a warning path (and
 * inside `void ...` without catch), where a corrupted storage cannot become an
 * unhandled rejection — in that case the language already in memory applies.
 */
export async function loadMainLocale(): Promise<void> {
  try {
    cached = resolveMainLocale(await readAppLanguage())
  } catch {
    cached = cached ?? 'en'
  }
}

/**
 * Translates a fixed sentence. Asynchronous because the language may not be in
 * memory yet (a late routine firing right after boot) and reading the storage
 * is asynchronous — the result is cached.
 */
export async function t(
  key: MainMessageKey,
  vars?: Record<string, string | number>,
): Promise<string> {
  if (cached === undefined) await loadMainLocale()
  return format(key, cached ?? 'en', vars)
}

/**
 * Synchronous version, for paths that cannot wait (the panel's activity
 * feed goes out in the order of the actions). It uses the language already in memory — the boot
 * loads it with `loadMainLocale` — and falls back to English if there is none yet.
 */
export function tNow(key: MainMessageKey, vars?: Record<string, string | number>): string {
  return format(key, cached ?? 'en', vars)
}

function format(key: MainMessageKey, locale: MainLocale, vars?: Record<string, string | number>): string {
  let text: string = MESSAGES[key][locale]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      // No `replaceAll`: the tsconfig target is ES2020.
      text = text.split(`{{${name}}}`).join(String(value))
    }
  }
  return text
}
