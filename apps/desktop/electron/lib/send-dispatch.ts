import type { BrowserWindow } from 'electron'
import type { SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { rejectSession as rejectSessionAsks } from './ask-broker'
import { abortChat, runChat, startSessionNaming } from './chat-engine'
import { abortLoop, runChatWithLoop } from './loop-engine'
import { abortOrchestration, runOrchestration } from './orchestrator'
import { clearSessionTrust } from './permission'
import { readJson } from './storage'

/**
 * Roteamento de um envio para a engine certa, e o encerramento de uma sessão.
 *
 * Isto morava dentro do `ipcMain.handle('chat:send')`, então valia só para
 * envios feitos NO desktop: o `messages:send` do companion chamava `runChat`
 * direto e o `chat:abort` dele parava metade das coisas. Na prática, do celular
 * o modo orquestra rodava como chat comum, o loop rodava um turno só, e parar a
 * execução deixava o loop girando e os pedidos pendurados.
 *
 * As engines não decidem nada disso sozinhas (o `runChat` nem lê
 * `options.orchestrate`), então o roteamento precisa ser um só para os dois
 * caminhos — é o que este módulo é.
 */

const LOOP_PADRAO = { maxIterations: 5 }

/**
 * O último envio de cada conversa. A resposta digitada nos painéis do Computer
 * Use sai com as MESMAS opções (modo computador, permissões, raciocínio) —
 * reconstruí-las fora do input da janela principal desligaria o controle no
 * meio da tarefa.
 */
const lastInputs = new Map<string, SendMessageInput>()

export function lastSendInput(sessionId: string): SendMessageInput | null {
  return lastInputs.get(sessionId) ?? null
}

/** Aplica as regras do modo e entrega à engine correspondente. */
export async function dispatchSend(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  lastInputs.set(input.sessionId, input)
  // Regra de ouro: workers não orquestram (sem recursão infinita).
  // Workers podem usar subagentes (limite de profundidade gerenciado pelo subagent tool).
  const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
  if (session?.orchestration?.role === 'worker') {
    input = { ...input, options: { ...input.options, orchestrate: undefined } }
  }
  // Nomear o chat AQUI, antes do roteamento: é o único ponto por onde passam
  // todas as origens (desktop, companion, Orquestra, Loop) e ele roda antes do
  // pré-processamento dos anexos, que pode levar dezenas de segundos. Antes o
  // título nascia no fim do turno — e o caminho da Orquestra (runOrchestration
  // não passa por runChatTurn) nunca nomeava nada.
  await startSessionNaming(win, input, session)
  // Orquestração é exclusiva do modo code
  if (input.options.orchestrate && input.mode !== 'code') {
    input = { ...input, options: { ...input.options, orchestrate: undefined } }
  }
  // Orquestração: desativa plano (incompatível) e o Loop — na orquestra quem
  // revisa é o orquestrador, com o orçamento das configurações da Orquestra
  // ("Ajustes por worker"). Antes o Loop era ligado aqui e as iterações dele
  // viravam, sem o usuário ver, o orçamento de revisão. Subagentes por padrão.
  if (input.options.orchestrate) {
    input = {
      ...input,
      options: {
        ...input.options,
        plan: undefined,
        loop: undefined,
        subagents: input.options.subagents !== false,
      },
      loopConfig: undefined,
    }
    void runOrchestration(win, input)
    return
  }
  if (input.options.loop) {
    void runChatWithLoop(win, input, input.loopConfig ?? LOOP_PADRAO)
    return
  }
  void runChat(win, input)
}

/** Para tudo que a sessão tem em andamento — engines, pedidos pendentes e a
 *  confiança concedida no turno. Parar pela metade deixava o loop girando. */
export function abortSession(sessionId: string): void {
  abortChat(sessionId)
  abortLoop(sessionId)
  abortOrchestration(sessionId)
  rejectSessionAsks(sessionId)
  clearSessionTrust(sessionId)
}
