import type { ChatMessage, TextPart } from '@shared/chat'

/** Quantos caminhos citar antes de resumir: a nota é contexto, não um log. */
const WRITE_LIMIT = 12

/** Quanto do texto interrompido cabe na nota. O fim é o que mostra onde parou. */
const TEXT_LIMIT = 240

/** Uma linha, sem "]" — o formato que ENGINE_MARKER_LINE reconhece. */
function flat(text: string): string {
  return text.replace(/[[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Nota de engine para um turno REFEITO ("tentar novamente").
 *
 * Vai no request e nunca na tela: é anexada à última mensagem do usuário (ver
 * `withMemoryBlock` no chat-engine) e o `stripEngineMarkers` garante que ela não
 * vaze para a resposta visível.
 *
 * Sem ela o modelo recomeça como se fosse a primeira vez. A resposta que falhou
 * sai do histórico, então ele não tem como saber que já houve uma tentativa: ou
 * reescreve o que já está no disco, ou trata como pronto o que ficou pela
 * metade. Com a nota ele entra sabendo o que falhou, o que pode ter ficado
 * quebrado e que o certo é conferir antes de continuar.
 *
 * Uma linha só e sem "]" no meio: é o formato que ENGINE_MARKER_LINE
 * (todo-context.ts) reconhece e remove.
 */
export function retryContextNote(failed: ChatMessage): string {
  // O texto do erro é diagnóstico do provedor: pode ter colchetes, quebras de
  // linha e centenas de caracteres. A nota é uma linha, então cabe só o começo.
  const error = flat(failed.error ?? '').slice(0, 240)
  // ToolParts nunca voltam ao modelo, então o texto que a tentativa anterior
  // chegou a escrever é o único fio da narrativa dela — e o fim é onde parou.
  const written = flat(
    failed.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join(' '),
  )
  const tools = failed.parts.filter((p) => p.type === 'tool')
  const toolErrors = tools.filter((p) => p.state === 'error').length
  const writes = failed.snapshot?.authored ?? []

  const said = [
    'this is a RETRY of the same request from the user, not a new one',
    error
      ? `the previous attempt stopped with "${error}"`
      : 'the previous attempt was interrupted before it finished',
  ]
  if (tools.length > 0) {
    const calls = `${tools.length} tool call${tools.length === 1 ? '' : 's'}`
    said.push(toolErrors > 0 ? `after ${calls} (${toolErrors} of them ended in error)` : `after ${calls}`)
  }
  if (writes.length > 0) {
    // Colchete num caminho (src/[id].tsx) quebraria a linha única do marcador:
    // a nota inteira deixaria de casar com ENGINE_MARKER_LINE e vazaria para a
    // resposta visível. O caminho fica sem os colchetes, e só aqui.
    const shown = writes
      .slice(0, WRITE_LIMIT)
      .map((rel) => rel.replace(/[[\]]/g, ''))
      .join(', ')
    const rest = writes.length > WRITE_LIMIT ? ` (+${writes.length - WRITE_LIMIT} more)` : ''
    said.push(
      `it had already written ${shown}${rest} — those files may be half-done, so read them before building on them`,
    )
  } else if (tools.length > 0) {
    said.push('whatever it changed on disk may be half-done, so check the real state before repeating those calls')
  } else {
    said.push('nothing had run when it failed')
  }
  if (written.length > 0) {
    const tail = written.slice(-TEXT_LIMIT)
    said.push(
      `its last text stopped at "…${tail}" — do not repeat that word for word, but stay consistent with it`,
    )
  }
  said.push(
    tools.length > 0 || writes.length > 0
      ? 'resume from where it stopped instead of starting over'
      : 'go straight to the task',
  )
  return `[SYSTEM: ${said.join('. ')}.]`
}
