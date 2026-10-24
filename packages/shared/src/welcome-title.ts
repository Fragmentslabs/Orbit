/**
 * Título da tela inicial ("Pronto para começar?").
 *
 * A frase muda a cada abertura do app: o sorteio usa uma semente de escopo de
 * módulo, avaliada uma vez por processo. Navegar entre chat e código, trocar de
 * pasta ou reabrir uma conversa não troca o texto debaixo do usuário.
 *
 * A escolha depende do MODO e do NOME aprendido:
 * - chat: convite e conversa; com nome, cumprimenta ("Olá, Ana.").
 * - código: construção e ponto de partida ("O que vamos construir hoje?").
 *
 * Sem nome, as variantes com nome não entram no sorteio — nada de "Olá, .".
 * As frases são curtas de propósito: o título é `whitespace-nowrap` na tela, e
 * frase comprida estoura a coluna em vez de quebrar linha.
 *
 * Vive no shared para o app mobile usar a mesma regra e para o sorteio ser
 * testável sem Electron.
 */

export type WelcomeTitleMode = 'chat' | 'code'

export interface WelcomeTitleInput {
  mode: WelcomeTitleMode
  /** Nome aprendido na conversa ou digitado nas Preferências. */
  userName?: string | null
  /** Hora local (0–23), para "Bom dia/Boa tarde/Boa noite". Default: agora. */
  hour?: number
  /** 0..1. Só os testes passam; em produção vale a semente da abertura. */
  seed?: number
}

/** Convite e conversa, sem nome. */
const CHAT_PLAIN = [
  'chat.empty.startTitle',
  'chat.empty.titleHelloCasual',
  'chat.empty.titleHowAreYou',
  'chat.empty.titleWhatShallWeDo',
] as const

/** Chat com nome: a saudação é a primeira impressão. A da hora entra no meio. */
const CHAT_NAMED = [
  'chat.empty.hello',
  'chat.empty.titleGoodToSee',
  'chat.empty.titleWhereStartName',
  'chat.empty.titleReadyName',
] as const

/** Código sem nome: construção e ponto de partida. */
const CODE_PLAIN = [
  'chat.empty.startTitle',
  'chat.empty.titleWhatToBuild',
  'chat.empty.titleWhatToTackle',
  'chat.empty.titleWhatToWorkOn',
  'chat.empty.titleWhereStart',
  'chat.empty.titleFirstStep',
] as const

/**
 * Código com nome: as mesmas ideias, sem o "hoje" — o nome come espaço e o
 * título não quebra linha.
 */
const CODE_NAMED = [
  'chat.empty.titleWhatToBuildName',
  'chat.empty.titleWhatToWorkOnName',
  'chat.empty.titleReadyName',
] as const

const DAY_GREETINGS = [
  'chat.empty.titleMorning',
  'chat.empty.titleAfternoon',
  'chat.empty.titleEvening',
] as const

/** Todas as chaves que o sorteio pode devolver (o teste de i18n usa esta lista). */
export const WELCOME_TITLE_KEYS: readonly string[] = [
  ...new Set<string>([...CHAT_PLAIN, ...CHAT_NAMED, ...CODE_PLAIN, ...CODE_NAMED, ...DAY_GREETINGS]),
]

/** Semente da abertura: sorteada uma vez, quando o módulo carrega. */
const LAUNCH_SEED = Math.random()

/** "Bom dia" até meio-dia, "Boa tarde" até as 18h, "Boa noite" no resto. */
function dayGreetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return DAY_GREETINGS[0]
  if (hour >= 12 && hour < 18) return DAY_GREETINGS[1]
  return DAY_GREETINGS[2]
}

function chatNamedPool(hour: number): readonly string[] {
  return [CHAT_NAMED[0], dayGreetingKey(hour), ...CHAT_NAMED.slice(1)]
}

/** Índice uniforme em [0, length), tolerante a seed fora de faixa. */
function indexFor(seed: number, length: number): number {
  const safe = Number.isFinite(seed) ? Math.min(Math.max(seed, 0), 0.999999) : 0
  return Math.floor(safe * length)
}

/**
 * Devolve a CHAVE de i18n do título — quem chama resolve com `t(key, { name })`.
 * Assim a tradução fica onde as outras ficam, e o sorteio não depende do idioma.
 */
export function pickWelcomeTitle({ mode, userName, hour, seed }: WelcomeTitleInput): string {
  const hasName = Boolean(userName?.trim())
  const pool =
    mode === 'code'
      ? hasName
        ? CODE_NAMED
        : CODE_PLAIN
      : hasName
        ? chatNamedPool(hour ?? new Date().getHours())
        : CHAT_PLAIN
  return pool[indexFor(seed ?? LAUNCH_SEED, pool.length)] ?? CHAT_PLAIN[0]
}
