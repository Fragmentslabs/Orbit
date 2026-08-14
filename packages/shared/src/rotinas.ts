/**
 * Rotinas do modo código — chats que voltam sozinhos.
 *
 * Uma rotina é um prompt + uma agenda. Na hora marcada o scheduler do main
 * cria uma sessão de chat nova e despacha pelo MESMO caminho do `chat:send`
 * (runChat / runChatWithLoop / runOrchestration): de graça vêm loop,
 * orquestração, diff por mensagem, permissões e a UI de chat que já existe.
 *
 * Cada execução é uma sessão própria (`rotina_<id>_<ts>`, com `routineId`), e
 * não uma conversa única que cresce: é o que permite o histórico de runs no
 * painel e a exclusão individual pela sidebar. O "lembrar do dia anterior"
 * fica por conta do Brain, ligado nos modos da rotina.
 *
 * Os nomes do domínio ficam em português porque são o vocabulário do produto
 * (como no modo esteira); o resto do código segue a convenção do repo.
 */

import type { PermissionMode, SendMessageOptions } from './chat'

/** Prefixo dos ids de sessão criados por rotina. */
export const ROTINA_SESSION_PREFIX = 'rotina_'

// ─── Agenda ──────────────────────────────────────────────────────────────────

/**
 * Agenda ESTRUTURADA, não cron: o gerador devolve `{ horario, dias }` e o
 * cálculo do próximo disparo é código puro (testável, sem dependência nova) —
 * uma string cron seria impossível de editar na tela de revisão.
 */
export interface Agenda {
  /** "HH:MM" no fuso local da máquina */
  horario: string
  /** Dias da semana (0 = domingo). Ausente/vazio = todo dia. */
  dias?: number[]
  /** Alternativa a `dias`: a cada N dias contados da última execução. */
  intervaloDias?: number
}

// ─── Modos ───────────────────────────────────────────────────────────────────

/**
 * Modos confirmados pelo usuário na tela de revisão. É um subconjunto
 * serializável de SendMessageOptions — o resto das options (planReview, plano
 * de orquestração) é estado de um turno, não configuração de uma rotina.
 */
export interface RotinaModos {
  loop?: boolean
  subagents?: boolean
  orchestrate?: boolean
  brain?: boolean
  simple?: boolean
  plan?: boolean
  browser?: boolean
  /** Padrão "approve" (Autonomia), o mesmo default de um chat de código. */
  permissionMode?: PermissionMode
}

/** Ordem em que os modos aparecem nas badges e no editor. */
export const ROTINA_MODOS: (keyof Omit<RotinaModos, 'permissionMode'>)[] = [
  'brain',
  'loop',
  'subagents',
  'orchestrate',
  'browser',
  'plan',
  'simple',
]

/** Modos de permissão oferecidos à rotina, na ordem exibida. */
export const ROTINA_PERMISSOES: PermissionMode[] = ['approve', 'full', 'ask']

export const ROTINA_PERMISSAO_PADRAO: PermissionMode = 'approve'

/** Modos → options do chat. Espelha as regras do handler `chat:send`. */
export function opcoesDaRotina(modos: RotinaModos): SendMessageOptions {
  const options: SendMessageOptions = {
    // "Autonomia" executa sozinho e só para em ação crítica. Quando para, o
    // pedido aparece no chat da própria execução e a sessão fica com o ponto
    // de "aguardando resposta" na sidebar — é assim que a rotina avisa.
    permissionMode: modos.permissionMode ?? ROTINA_PERMISSAO_PADRAO,
  }
  if (modos.brain) options.brain = true
  if (modos.browser) options.browser = true
  if (modos.simple) options.simple = true
  if (modos.orchestrate) {
    // Orquestração desativa plano e liga loop/subagentes, como no chat:send
    options.orchestrate = {}
    options.loop = modos.loop !== false
    options.subagents = modos.subagents !== false
    return options
  }
  if (modos.loop) options.loop = true
  if (modos.subagents) options.subagents = true
  if (modos.plan) options.plan = true
  return options
}

// ─── Rotina ──────────────────────────────────────────────────────────────────

export interface RotinaModelo {
  providerId: string
  modelId: string
}

export interface Rotina {
  id: string
  titulo: string
  /** Prompt autocontido enviado a cada execução */
  prompt: string
  agenda: Agenda
  modelo: RotinaModelo
  modos: RotinaModos
  /** Pastas de trabalho, herdadas do workspace no momento da criação */
  pastas: string[]
  ativa: boolean
  criadoEm: number
  ultimaExecucao?: number
}

/** Entrada de criação/edição (o id e o criadoEm são do main). */
export interface NovaRotinaInput {
  titulo: string
  prompt: string
  agenda: Agenda
  modelo: RotinaModelo
  modos: RotinaModos
  pastas: string[]
  ativa?: boolean
}

// ─── Execuções ───────────────────────────────────────────────────────────────

export type RotinaRunStatus = 'rodando' | 'ok' | 'erro'

/**
 * Métricas de UMA execução, chaveadas pelo sessionId. A lista exibida no
 * painel é DERIVADA das sessões (`sessions.filter(s => s.routineId === id)`):
 * apagar o chat na sidebar faz o run sumir sozinho, sem estado "excluído"
 * pendurado.
 */
export interface RotinaRun {
  rotinaId: string
  sessionId: string
  iniciadoEm: number
  concluidoEm?: number
  status: RotinaRunStatus
  erro?: string
  tokens: number
  custo: number
}

// ─── Geração (prompt do usuário → rotina proposta) ───────────────────────────

/** Saída do passo 1 → 2: o modelo propõe, o usuário confirma na revisão. */
export interface RotinaSugestao {
  titulo: string
  prompt: string
  agenda: Agenda
  modos: RotinaModos
}

export type ResultadoGeracao =
  | { ok: true; sugestao: RotinaSugestao }
  | { ok: false; erro: string }

// ─── Eventos (main → renderer) ───────────────────────────────────────────────

export type RotinaEvent =
  | { type: 'rotinas'; rotinas: Rotina[] }
  | { type: 'rotina'; rotina: Rotina }
  | { type: 'rotina-removida'; id: string }
  | { type: 'run'; run: RotinaRun }

// ─── Cálculo do próximo disparo ──────────────────────────────────────────────

const DIA_MS = 24 * 60 * 60 * 1000

/** "09:00" → { hora: 9, minuto: 0 }. Retorna null em horário inválido. */
export function parseHorario(horario: string): { hora: number; minuto: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(horario.trim())
  if (!match) return null
  const hora = Number(match[1])
  const minuto = Number(match[2])
  if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return null
  return { hora, minuto }
}

function comHorario(base: Date, hora: number, minuto: number): number {
  const d = new Date(base)
  d.setHours(hora, minuto, 0, 0)
  return d.getTime()
}

/**
 * Próximo instante de execução ESTRITAMENTE depois de `depoisDe`.
 *
 * `ultimaExecucao` só importa para `intervaloDias` (a contagem parte dela);
 * nas agendas por dia da semana o calendário já define tudo.
 *
 * Retorna null quando a agenda é inválida — a rotina não dispara em vez de
 * disparar num horário adivinhado.
 */
export function proximaExecucao(
  agenda: Agenda,
  depoisDe: number,
  ultimaExecucao?: number,
): number | null {
  const hm = parseHorario(agenda.horario)
  if (!hm) return null
  const { hora, minuto } = hm
  const base = new Date(depoisDe)

  if (agenda.intervaloDias && agenda.intervaloDias > 0) {
    const passo = Math.floor(agenda.intervaloDias)
    // O avanço é em DIAS DE CALENDÁRIO, não em múltiplos de 24h: somar
    // milissegundos atravessa um horário de verão e a rotina das 09:00 passa a
    // rodar às 08:00 (ou 10:00) para sempre.
    const ancora = new Date(ultimaExecucao ?? depoisDe)
    const dia = new Date(ancora.getFullYear(), ancora.getMonth(), ancora.getDate())
    // Sem execução anterior, a primeira cai no próximo horário disponível.
    if (ultimaExecucao) dia.setDate(dia.getDate() + passo)
    let alvo = comHorario(dia, hora, minuto)
    if (alvo <= depoisDe) {
      // Salto em O(1): avançar de `passo` em `passo` num app fechado por meses
      // custaria milhares de iterações a cada tick do scheduler. O laço depois
      // só corrige a borda (no máximo uma ou duas voltas).
      const saltos = Math.ceil((Math.floor((depoisDe - alvo) / DIA_MS) + 1) / passo)
      dia.setDate(dia.getDate() + saltos * passo)
      alvo = comHorario(dia, hora, minuto)
      while (alvo <= depoisDe) {
        dia.setDate(dia.getDate() + passo)
        alvo = comHorario(dia, hora, minuto)
      }
    }
    return alvo
  }

  const dias = agenda.dias?.length ? new Set(agenda.dias) : null
  // 8 tentativas cobrem a semana inteira + o "hoje já passou do horário".
  for (let offset = 0; offset < 8; offset++) {
    const dia = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    if (dias && !dias.has(dia.getDay())) continue
    const alvo = comHorario(dia, hora, minuto)
    if (alvo > depoisDe) return alvo
  }
  return null
}

/** Próxima execução de uma rotina ativa (null quando desligada ou inválida). */
export function proximaExecucaoDaRotina(rotina: Rotina, agora = Date.now()): number | null {
  if (!rotina.ativa) return null
  return proximaExecucao(rotina.agenda, agora, rotina.ultimaExecucao)
}
