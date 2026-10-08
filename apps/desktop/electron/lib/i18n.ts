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
} as const satisfies Record<string, Record<MainLocale, string>>

export type MainMessageKey = keyof typeof MESSAGES

/** Idioma em memória — evita reler o storage a cada frase de uma notificação. */
let cached: MainLocale | undefined

/** "Portuguese"/"pt-BR"/"pt" → pt-BR; qualquer outra coisa (inclusive vazio) → en. */
export function resolveMainLocale(language: string | undefined): MainLocale {
  const value = (language ?? '').trim().toLowerCase()
  return value.startsWith('pt') || value.startsWith('portuguese') ? 'pt-BR' : 'en'
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
  const locale = cached ?? 'en'
  let text: string = MESSAGES[key][locale]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      // Sem `replaceAll`: o target do tsconfig é ES2020.
      text = text.split(`{{${name}}}`).join(String(value))
    }
  }
  return text
}
