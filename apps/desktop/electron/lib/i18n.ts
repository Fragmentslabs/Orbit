import { readAppLanguage } from './app-language'

/**
 * i18n do processo main.
 *
 * O renderer traduz a própria UI com i18next, mas o main também produz texto
 * que o usuário lê fora dela: títulos e corpos das notificações nativas
 * (pergunta/permissão pendente, mensagem concluída, erro de chat, rotina).
 * Antes disso ele só sabia português, então um app em inglês recebia banner em
 * português.
 *
 * O idioma é o mesmo que o renderer publica em `app:setLanguage` (nome do
 * idioma em inglês, ex.: "Portuguese") — o valor que o scheduler de rotinas já
 * usa para os prompts. O renderer publica no boot e a cada troca, então basta
 * espelhar aqui: `setMainLocale` no handler do IPC e `loadMainLocale` no boot.
 *
 * Só entram aqui frases fixas do produto. Texto de conteúdo (título da sessão,
 * preview da resposta, mensagem crua do provedor) não se traduz: é dado.
 */

/** Idiomas que o app fala. Espelha os locales do renderer (src/i18n/locales). */
export type MainLocale = 'pt-BR' | 'en'

/**
 * Frases fixas do main. Chaves planas com ponto: o consumidor pede
 * `t('notif.chatError.title')` e o tipo `MainMessageKey` recusa chave inexistente.
 * Exportado para o teste conferir que os dois idiomas cobrem toda chave.
 */
export const MESSAGES = {
  // ── Pergunta/permissão pendente ───────────────────────────────────────────
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

  // ── Erro de chat ──────────────────────────────────────────────────────────
  'notif.chatError.title': {
    'pt-BR': 'Erro no chat',
    en: 'Chat error',
  },
  'notif.chatError.unexpected': {
    'pt-BR': 'erro inesperado',
    en: 'unexpected error',
  },
  // Motivo curto por tipo de falha — o card no app traz a explicação completa
  // (i18n do renderer, chat.errorKind.*) e o texto cru do provedor.
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

  // ── Rotinas agendadas ─────────────────────────────────────────────────────
  'notif.rotina.done': {
    'pt-BR': 'Rotina concluída',
    en: 'Routine finished',
  },
  'notif.rotina.doneWithCost': {
    'pt-BR': 'Rotina concluída — US$ {{cost}}',
    en: 'Routine finished — US$ {{cost}}',
  },
  'notif.rotina.failed': {
    'pt-BR': 'Rotina falhou: {{error}}',
    en: 'Routine failed: {{error}}',
  },
  'notif.rotina.unknownError': {
    'pt-BR': 'erro desconhecido',
    en: 'unknown error',
  },
  // ── Permissões de site no navegador integrado ──────────────────────────────
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
  // ── Bandeja do sistema ────────────────────────────────────────────────────
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

  // ── Resultado do /init (mensagem do assistente no chat) ───────────────────
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

  // ── Feed de atividade do browser do painel ────────────────────────────────
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

  // ── Fontes da conversa (erros devolvidos à UI) ────────────────────────────
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
  // ── Computer Use: faixa no topo da tela enquanto o agente controla um app ──
  'computer.overlay': {
    'pt-BR': 'Orbit está controlando {{apps}} — ⌘⇧. para parar',
    en: 'Orbit is controlling {{apps}} — ⌘⇧. to stop',
  },
} as const satisfies Record<string, Record<MainLocale, string>>

export type MainMessageKey = keyof typeof MESSAGES

/** Idioma em memória — evita reler o storage a cada frase de uma notificação. */
let cached: MainLocale | undefined

/** "Portuguese"/"pt-BR"/"pt" → pt-BR; qualquer outra coisa (inclusive vazio) → en. */
export function resolveMainLocale(language: string | undefined): MainLocale {
  const value = (language ?? '').trim().toLowerCase()
  return value.startsWith('pt') || value.startsWith('portuguese') ? 'pt-BR' : 'en'
}

/** O idioma já em memória (sem ler o storage) — para quem não pode esperar,
 *  como a fala que precisa de um idioma de reserva. */
export function currentMainLocale(): MainLocale | undefined {
  return cached
}

/** Espelha o idioma publicado pelo renderer (`app:setLanguage`). */
export function setMainLocale(language: string): void {
  cached = resolveMainLocale(language)
}

/**
 * Carrega o idioma persistido — chamado no boot e, sob demanda, na primeira
 * frase de cada notificação. Nunca lança: `t()` roda em caminho de aviso (e
 * dentro de `void ...` sem catch), onde um storage corrompido não pode virar
 * rejection sem tratamento — nesse caso vale o idioma já em memória.
 */
export async function loadMainLocale(): Promise<void> {
  try {
    cached = resolveMainLocale(await readAppLanguage())
  } catch {
    cached = cached ?? 'en'
  }
}

/**
 * Traduz uma frase fixa. Assíncrona porque o idioma pode ainda não estar em
 * memória (rotina atrasada disparando logo depois do boot) e a leitura do
 * storage é assíncrona — o resultado fica em cache.
 */
export async function t(
  key: MainMessageKey,
  vars?: Record<string, string | number>,
): Promise<string> {
  if (cached === undefined) await loadMainLocale()
  return format(key, cached ?? 'en', vars)
}

/**
 * Versão síncrona, para caminhos que não podem esperar (o feed de atividade
 * do painel sai na ordem das ações). Usa o idioma já em memória — o boot
 * carrega com `loadMainLocale` — e cai em inglês se ainda não houver.
 */
export function tNow(key: MainMessageKey, vars?: Record<string, string | number>): string {
  return format(key, cached ?? 'en', vars)
}

function format(key: MainMessageKey, locale: MainLocale, vars?: Record<string, string | number>): string {
  let text: string = MESSAGES[key][locale]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      // Sem `replaceAll`: o target do tsconfig é ES2020.
      text = text.split(`{{${name}}}`).join(String(value))
    }
  }
  return text
}
