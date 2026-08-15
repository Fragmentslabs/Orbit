import { streamText } from 'ai'
import type { Agenda, ResultadoGeracao, RotinaModelo, RotinaModos, RotinaSugestao } from '@shared/rotinas'
import { parseHorario, ROTINA_PERMISSAO_PADRAO } from '@shared/rotinas'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { interleavedReasoningField, normalizeMessages } from '../reasoning'

/**
 * Passo 1 → 2 da criação de rotina: o usuário descreve o que quer em texto
 * corrido e o modelo devolve título, prompt refinado, agenda e modos sugeridos.
 *
 * Roda headless (sem sessão de chat, sem tools), como o runner da esteira: o
 * ciclo aqui é uma pergunta e uma resposta em JSON, não uma conversa. O
 * usuário confirma tudo na tela de revisão — nada do que sai daqui vai direto
 * para o disco.
 */

const SYSTEM = `You design scheduled routines for Orbit's CODE mode: a routine is a prompt that an autonomous coding agent runs by itself, on a schedule, inside the user's working folders.

From the user's description, produce ONE routine.

Rules:
- The prompt must be SELF-CONTAINED: the agent that runs it has no memory of this conversation and no one to ask. State the goal, the folders/files involved when known, what to inspect, and what a finished run looks like.
- Write titulo and prompt in the SAME LANGUAGE as the user's description (a Portuguese description yields a Portuguese prompt — never switch to English unless asked).
- The routine's result is a chat message the user reads: by default the prompt just answers in the chat. It must NOT create, modify or delete files, folders or scripts in the working folders, and must not commit or install anything, unless the user's description EXPLICITLY asks to persist something to disk (e.g. "save to a file", "write a JSON"). If the goal is delivering information — a greeting, the news, a summary — deliver it as plain text in the reply.
- The routine runs unattended: never ask the user questions in the prompt, never require an approval step.
- agenda.horario is "HH:MM" (24h, local time). agenda.dias is 0-6 with 0 = Sunday; omit dias for every day. Use intervaloDias only when the user asks for "every N days".
- If the user gave no time, pick a sensible one and say so in the title context, not in the prompt.
- Suggest modes conservatively, based on the work:
  - loop: multi-step work that benefits from reviewing its own output before stopping.
  - subagents: work that splits into independent parallel investigations.
  - orchestrate: only for large tasks that need a plan and several workers; it implies loop + subagents.
  - brain: the routine should remember previous runs (daily reports, follow-ups, anything cumulative).
  - browser: the routine has to look at a running web UI.
  - plan and simple: leave false unless the user clearly asked for a plan-only or plain-text routine.

Answer with JSON ONLY — no prose, no markdown fences:
{"titulo":"...","prompt":"...","agenda":{"horario":"09:00","dias":[1,2,3,4,5]},"modos":{"loop":true,"subagents":false,"orchestrate":false,"brain":true,"browser":false,"plan":false,"simple":false}}`

const MAX_SAIDA = 20_000

/** Extrai o objeto JSON da resposta (modelos insistem em cercar com ``` ou prosa). */
function extrairJson(texto: string): unknown {
  const semFence = texto.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
  const inicio = semFence.indexOf('{')
  const fim = semFence.lastIndexOf('}')
  if (inicio < 0 || fim <= inicio) return null
  try {
    return JSON.parse(semFence.slice(inicio, fim + 1))
  } catch {
    return null
  }
}

function normalizarAgenda(bruta: unknown): Agenda {
  const obj = (bruta ?? {}) as Record<string, unknown>
  const horario = typeof obj.horario === 'string' && parseHorario(obj.horario) ? obj.horario.trim() : '09:00'
  const agenda: Agenda = { horario }
  if (Array.isArray(obj.dias)) {
    const dias = [...new Set(obj.dias.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    // 7 dias marcados = "todo dia": guardar a lista cheia só faria a UI
    // mostrar sete chips onde cabe uma frase.
    if (dias.length > 0 && dias.length < 7) agenda.dias = dias
  }
  const intervalo = Number(obj.intervaloDias)
  if (Number.isInteger(intervalo) && intervalo > 1 && !agenda.dias) agenda.intervaloDias = intervalo
  return agenda
}

function normalizarModos(bruto: unknown): RotinaModos {
  const obj = (bruto ?? {}) as Record<string, unknown>
  const bool = (chave: string) => obj[chave] === true
  const modos: RotinaModos = { permissionMode: ROTINA_PERMISSAO_PADRAO }
  if (bool('loop')) modos.loop = true
  if (bool('subagents')) modos.subagents = true
  if (bool('orchestrate')) modos.orchestrate = true
  if (bool('brain')) modos.brain = true
  if (bool('browser')) modos.browser = true
  if (bool('simple')) modos.simple = true
  // Plano é incompatível com execução sozinha (ficaria parado esperando
  // aprovação) e com orquestração — o gerador não pode ligá-lo por engano.
  if (bool('plan') && !modos.orchestrate) modos.plan = true
  return modos
}

export async function gerarRotina(
  descricao: string,
  modelo: RotinaModelo,
  pastas: string[],
  idioma?: string,
): Promise<ResultadoGeracao> {
  const texto = descricao.trim()
  if (!texto) return { ok: false, erro: 'Descreva a rotina antes de gerar.' }

  const provider = await getProvider(modelo.providerId)
  const contexto = [
    pastas.length ? `Working folders: ${pastas.join(', ')}` : 'Working folders: (none selected)',
    idioma ? `User language: ${idioma}` : null,
    `Today: ${new Date().toISOString().slice(0, 10)} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })})`,
  ]
    .filter(Boolean)
    .join('\n')

  let saida = ''
  try {
    const model = await resolveModel(modelo.providerId, modelo.modelId)
    const stream = streamText({
      model,
      system: SYSTEM,
      messages: normalizeMessages(
        [{ role: 'user', content: `${contexto}\n\n## Routine described by the user\n${texto}` }],
        interleavedReasoningField(provider, modelo.modelId),
      ),
      onError: () => {
        /* tratado abaixo pelo erro acumulado */
      },
    })
    for await (const parte of stream.fullStream) {
      if (parte.type === 'text-delta') {
        saida += parte.text
        if (saida.length > MAX_SAIDA) break
      } else if (parte.type === 'error') {
        const detalhe = parte.error instanceof Error ? parte.error.message : String(parte.error)
        return { ok: false, erro: detalhe }
      }
    }
  } catch (err) {
    return { ok: false, erro: err instanceof Error ? err.message : String(err) }
  }

  const bruto = extrairJson(saida) as Record<string, unknown> | null
  if (!bruto) {
    return { ok: false, erro: 'O modelo não devolveu JSON válido. Tente de novo ou troque de modelo.' }
  }

  const prompt = typeof bruto.prompt === 'string' ? bruto.prompt.trim() : ''
  if (!prompt) return { ok: false, erro: 'A resposta do modelo veio sem o prompt da rotina.' }

  const sugestao: RotinaSugestao = {
    titulo: (typeof bruto.titulo === 'string' && bruto.titulo.trim()) || texto.slice(0, 60),
    prompt,
    agenda: normalizarAgenda(bruto.agenda),
    modos: normalizarModos(bruto.modos),
  }
  return { ok: true, sugestao }
}
