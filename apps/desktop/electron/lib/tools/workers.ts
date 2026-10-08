import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { StorageKeys, type ChatMessage, type SessionInfo } from '@shared/chat'
import { listKeys, readJson } from '../storage'
import { getRunningSessionIds } from '../chat-engine'

/**
 * Ferramentas do orquestrador sobre os workers que ele já criou — em qualquer
 * plano desta conversa, não só no que está rodando. Antes ele só via os
 * workers na fase de revisão (lista em memória, que sumia ao fim da execução):
 * no turno seguinte não sabia quais existiam, não lia as conversas, não via o
 * que o usuário mandou direto num worker e só sabia criar workers novos.
 */

/** Teto de texto por mensagem no read_worker — tool output detalhado não cabe. */
const MAX_MESSAGE_CHARS = 4000
/** Teto do texto devolvido pelo message_worker. */
const MAX_REPLY_CHARS = 6000
/** Quantos workers o aviso automático lista (os mais recentes). */
const NOTICE_MAX_WORKERS = 20

export async function loadWorkers(orchestratorSessionId: string): Promise<SessionInfo[]> {
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))
  return sessions
    .filter((s): s is SessionInfo =>
      s != null &&
      s.orchestration?.role === 'worker' &&
      (s.parentId ?? s.orchestration.parentSessionId) === orchestratorSessionId,
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

function messageText(m: ChatMessage): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n')
    .trim()
}

/**
 * A mensagem de usuário veio do orquestrador? Mensagens novas trazem `origin`;
 * nas antigas (antes da marca) a primeira é sempre o prompt da tarefa e as de
 * revisão começam com "[Revisão N]".
 */
function fromOrchestrator(m: ChatMessage, firstUserId: string | undefined): boolean {
  if (m.origin === 'orchestrator') return true
  return m.id === firstUserId || messageText(m).startsWith('[Revisão')
}

interface WorkerDigest {
  session: SessionInfo
  status: 'running' | 'error' | 'idle'
  messageCount: number
  /** Mensagens que o próprio usuário digitou no chat do worker */
  direct: ChatMessage[]
  lastActivity: number
}

async function digest(session: SessionInfo, running: Set<string>): Promise<WorkerDigest> {
  const messages = await loadMessages(session.id)
  const firstUserId = messages.find((m) => m.role === 'user')?.id
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  return {
    session,
    status: running.has(session.id) ? 'running' : lastAssistant?.error ? 'error' : 'idle',
    messageCount: messages.length,
    direct: messages.filter((m) => m.role === 'user' && !fromOrchestrator(m, firstUserId)),
    lastActivity: messages.at(-1)?.createdAt ?? session.updatedAt,
  }
}

function ago(ts: number, now: number): string {
  const min = Math.round((now - ts) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Aviso automático para o prompt do orquestrador: quais workers existem e o
 * que o usuário mandou direto neles desde o último turno do orquestrador.
 * Vazio quando a conversa ainda não tem workers.
 */
export async function buildWorkersNotice(orchestratorSessionId: string, since: number): Promise<string> {
  const workers = await loadWorkers(orchestratorSessionId)
  if (workers.length === 0) return ''
  const running = new Set(getRunningSessionIds())
  const now = Date.now()
  const digests = await Promise.all(workers.slice(-NOTICE_MAX_WORKERS).map((w) => digest(w, running)))
  const lines = digests.map((d) => {
    const head = `- "${d.session.title}" (workerId: ${d.session.id}) — ${d.status}, ${d.messageCount} messages, last activity ${ago(d.lastActivity, now)}${d.session.archived ? ', archived' : ''}`
    const fresh = d.direct.filter((m) => m.createdAt > since)
    if (fresh.length === 0) return head
    const quotes = fresh.slice(-3).map((m) => `    > "${snippet(messageText(m))}"`).join('\n')
    return `${head}\n  ⚠ The USER wrote directly in this worker ${fresh.length} time(s) since your last turn:\n${quotes}`
  })
  const hidden = workers.length - digests.length
  return [
    '\n\nWorkers you already created in this conversation (from any earlier plan). They keep their own chat and context:',
    ...lines,
    hidden > 0 ? `(${hidden} older worker(s) not shown — list_workers shows all.)` : '',
    'Use read_worker to see a conversation, and message_worker to continue one — prefer that over a new task when the worker already has the context.',
  ].filter(Boolean).join('\n')
}

/** Executa um turno do worker com a mensagem do orquestrador e devolve a resposta. */
export type RunWorkerTurn = (worker: SessionInfo, message: string) => Promise<{ text: string; error?: string }>

export function createWorkerTools(orchestratorSessionId: string, runWorkerTurn: RunWorkerTurn): ToolSet {
  // Chamadas paralelas no mesmo passo: duas mensagens ao mesmo worker
  // disputariam o chat dele — a segunda recusa.
  const inFlight = new Set<string>()

  const findWorker = async (workerId: string) =>
    (await loadWorkers(orchestratorSessionId)).find((w) => w.id === workerId)

  return {
    list_workers: tool({
      description: [
        'Lists every worker you created in this conversation, from any plan, with status, message count,',
        'last activity and how many messages the USER typed directly in each worker.',
      ].join(' '),
      inputSchema: z.object({}),
      execute: async () => {
        const workers = await loadWorkers(orchestratorSessionId)
        if (workers.length === 0) return 'No workers in this conversation yet.'
        const running = new Set(getRunningSessionIds())
        const now = Date.now()
        const digests = await Promise.all(workers.map((w) => digest(w, running)))
        return digests
          .map((d) => {
            const task = d.session.orchestration?.task
            return [
              `- "${d.session.title}" (workerId: ${d.session.id}) — ${d.status}, ${d.messageCount} messages, last activity ${ago(d.lastActivity, now)}${d.session.archived ? ', archived' : ''}`,
              task && task !== d.session.title ? `  task: ${snippet(task)}` : '',
              d.direct.length > 0 ? `  user wrote directly here ${d.direct.length} time(s), last: "${snippet(messageText(d.direct.at(-1)!))}"` : '',
            ].filter(Boolean).join('\n')
          })
          .join('\n')
      },
    }),

    read_worker: tool({
      description: [
        'Reads a worker\'s conversation: messages from you (orchestrator), from the user typing directly in it,',
        'and the worker\'s replies. Tool calls are summarized by name. Returns the most recent messages first-to-last.',
      ].join(' '),
      inputSchema: z.object({
        workerId: z.string().describe('workerId from list_workers or the workers notice'),
        last: z.number().int().min(1).max(40).optional().describe('How many of the most recent messages. Default 10'),
        skip: z.number().int().min(0).optional().describe('Skip this many of the most recent messages (to page back). Default 0'),
      }),
      execute: async ({ workerId, last, skip }) => {
        const worker = await findWorker(workerId)
        if (!worker) return `No worker ${workerId} in this conversation. Call list_workers.`
        const messages = await loadMessages(worker.id)
        const firstUserId = messages.find((m) => m.role === 'user')?.id
        const end = messages.length - (skip ?? 0)
        const start = Math.max(0, end - (last ?? 10))
        if (end <= 0) return `"${worker.title}" has ${messages.length} messages — nothing before that.`
        const rendered = messages.slice(start, end).map((m, i) => {
          const who =
            m.role === 'assistant' ? 'worker' : fromOrchestrator(m, firstUserId) ? 'you (orchestrator)' : 'USER (typed directly)'
          const tools = m.parts.filter((p) => p.type === 'tool').map((p) => (p as { tool: string }).tool)
          const text = messageText(m)
          return [
            `### #${start + i + 1} ${who}${m.error ? ' — ERROR: ' + m.error : ''}`,
            tools.length > 0 ? `[tools: ${tools.join(', ')}]` : '',
            text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : text,
          ].filter(Boolean).join('\n')
        })
        return `Worker "${worker.title}" — messages ${start + 1}-${end} of ${messages.length}\n\n${rendered.join('\n\n')}`
      },
    }),

    message_worker: tool({
      description: [
        'Sends a new message to an existing worker and waits for its reply. It continues inside that worker\'s',
        'own chat, so the worker remembers everything it did and everything the user told it there.',
        'Prefer this over create_task when a worker already has the context (fixes, follow-ups, next steps).',
      ].join(' '),
      inputSchema: z.object({
        workerId: z.string().describe('workerId from list_workers or the workers notice'),
        message: z.string().describe('The instruction for the worker. It already has its context — no need to repeat it'),
      }),
      execute: async ({ workerId, message }) => {
        const worker = await findWorker(workerId)
        if (!worker) return `No worker ${workerId} in this conversation. Call list_workers.`
        if (inFlight.has(worker.id) || getRunningSessionIds().includes(worker.id)) {
          return `Worker "${worker.title}" is busy right now (running a turn). Wait for it or use another worker.`
        }
        inFlight.add(worker.id)
        try {
          const { text, error } = await runWorkerTurn(worker, message)
          if (error) return `Worker "${worker.title}" failed: ${error}${text ? `\n\nPartial reply:\n${text}` : ''}`
          const reply = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… [truncated — read_worker shows all]` : text
          return `Worker "${worker.title}" replied:\n\n${reply || '(no text)'}`
        } finally {
          inFlight.delete(worker.id)
        }
      },
    }),
  }
}
