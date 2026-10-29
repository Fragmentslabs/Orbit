/**
 * Leitura do TEXTO de uma mensagem no nível das partes.
 *
 * Vive no shared porque o main e o renderer precisam responder à MESMA
 * pergunta com a mesma regra: qual trecho de uma mensagem do assistente é a
 * resposta do turno. O renderer usa isso na bolha e na leitura em voz alta; o
 * main, no preview da notificação nativa — que antes pegava a PRIMEIRA parte
 * de texto e anunciava o preâmbulo do turno ("vou implementar…") no lugar da
 * resposta.
 */
import type { ChatMessage, MessagePart, TextPart } from './chat'

/**
 * Texto gerado pelo engine em continuações INTERNAS do turno (nudges de
 * verificação anti-overclaim e de fechamento da checklist) — nunca é a
 * resposta ao usuário. 'nudge'/'todo' renderizam apagados; 'internal' nem
 * chega a renderizar. Ver NO_CHANGES_PROMPT/TODO_COMPLETION_PROMPT e os
 * marcadores source em chat-engine.ts.
 */
export function isEngineText(source: TextPart['source']): boolean {
  return source === 'nudge' || source === 'todo' || source === 'internal'
}

/**
 * Índice (em segments) da primeira parte do ÚLTIMO bloco de texto contíguo
 * da mensagem. Um bloco é um run de partes consecutivas de texto/reasoning,
 * quebrado só por algo que não seja texto (ferramenta, agente, imagem): duas
 * partes de texto separadas apenas por reasoning são a MESMA resposta — é o
 * que acontece num corte por limite de tokens seguido de AUTO_CONTINUE, em
 * que a continuação reabre o raciocínio e o texto retoma de onde cortou.
 * Sem isso a UI promovia a continuação a "resposta final" e apagava o trecho
 * anterior (a "resposta sobreposta" por um resumo curto). Textos do engine
 * são invisíveis ao run (nem iniciam nem quebram um bloco): além de nunca
 * roubarem o lugar da resposta final, não apagam o bloco real à esquerda
 * quando aparecem depois dele.
 */
export function lastTextRunStart(
  segments: { kind: string; part?: MessagePart }[],
  /** Exige prosa (texto do modelo, sem source) dentro do bloco: um bloco só de
   *  raciocínio — turno que terminou pensando, sem escrever de novo — não conta
   *  como resposta final. Sem isto, a última prosa da mensagem viraria
   *  "narração" e o resumo não teria resposta nenhuma para mostrar. */
  requireProse = false,
): number {
  let runStart = -1
  let lastRunStart = -1
  let runHasProse = false
  for (let i = 0; i < segments.length; i++) {
    const part = segments[i].part
    // Texto do engine (nudge/todo/internal) é INVISÍVEL para o run: o source
    // dele já o apaga na UI, então nem inicia um bloco novo nem quebra o
    // atual. Se contasse, um nudge depois de uma ferramenta viraria o último
    // bloco e apagaria a resposta real (o sintoma "resposta sobreposta").
    if (segments[i].kind === 'part' && part?.type === 'text' && isEngineText(part.source)) {
      continue
    }
    const textish =
      segments[i].kind === 'part' &&
      part !== undefined &&
      (part.type === 'text' || part.type === 'reasoning')
    if (textish) {
      if (runStart === -1) {
        runStart = i
        runHasProse = false
      }
      if (part.type === 'text' && part.source === undefined) runHasProse = true
      if (!requireProse || runHasProse) lastRunStart = runStart
    } else {
      runStart = -1
      runHasProse = false
    }
  }
  return lastRunStart
}

/**
 * A RESPOSTA de um turno: a prosa do último bloco de texto contíguo.
 *
 * É o que a pessoa lê como resposta final no chat — e por isso também o que
 * deve aparecer num preview (banner nativo, aviso ao celular). A prosa
 * anterior a uma ferramenta é narração ("pensando alto"), não resposta: num
 * turno com ferramentas, a PRIMEIRA parte de texto é sempre o preâmbulo.
 *
 * Sem bloco de prosa (turno só de raciocínio/ferramentas) devolve "".
 */
export function lastProseText(mensagem: ChatMessage): string {
  const parts = mensagem.parts
  const start = lastTextRunStart(
    parts.map((part) => ({ kind: 'part', part })),
    true,
  )
  const bloco = start === -1 ? parts : parts.slice(start)
  return bloco
    .filter((part): part is TextPart => part.type === 'text' && part.source === undefined)
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/**
 * Texto que a LEITURA EM VOZ ALTA fala: a resposta final da mensagem, e só ela.
 *
 * É o `lastProseText` sem o que não se lê: o JSON do orbit-ui e o código do
 * diagrama mermaid são imagens inline, e falar os dois seria ler configuração
 * de gráfico em voz alta. Prosa do usuário nunca é lida (retorna "").
 *
 * Vive no shared porque as DUAS pontas falam: o desktop pelo `ChunkPlayer` do
 * renderer (IPC em streaming) e o celular pedindo o WAV em `/api/voice/speak`.
 * Se cada lado tivesse a sua regra, o mesmo turno sairia diferente no
 * computador e no telefone.
 */
export function speakableText(message: ChatMessage): string {
  if (message.role !== 'assistant') return ''
  return lastProseText(message)
    .replace(/```(?:orbit-ui|mermaid)[\s\S]*?(?:```|$)/g, '')
    .trim()
}

