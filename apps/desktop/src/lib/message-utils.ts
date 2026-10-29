import type { ChatViewMode } from "@shared/app-settings"
import { parseMessageReply } from "@shared/chat"
import { isEngineText, lastTextRunStart } from "@shared/chat-text"
import type { ChatMessage, FilePart, MessagePart, ReasoningPart, ToolPart } from "@shared/chat"

/**
 * Caminho real, no disco, de cada anexo cujo conteúdo NÃO deve atravessar a
 * memória do renderer (vídeos). Registrado quando o arquivo é adicionado ao
 * input — é a única hora em que o `File` ainda existe — e consumido na
 * conversão para data URL logo abaixo.
 */
const attachmentPaths = new Map<string, string>()

/** Um vídeo é pesado demais para virar data URL: passa por caminho quando há um. */
export function isLargeMediaType(mediaType: string | undefined, filename?: string): boolean {
  return !!mediaType?.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(filename ?? "")
}

/** O maior vídeo que ainda se aceita SEM caminho (colado da área de transferência). */
export const MAX_PASTED_VIDEO_BYTES = 150 * 1024 * 1024

/** `/home/a b/c.mp4` → `file:///home/a%20b/c.mp4` (e `C:\x\y.mp4` → `file:///C:/x/y.mp4`). */
export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`
  return `file://${encodeURI(withRoot).replace(/[?#]/g, (c) => (c === "?" ? "%3F" : "%23"))}`
}

/** Guarda o caminho de um arquivo do disco para o blob URL dele (ver acima). */
export function rememberAttachmentPath(blobUrl: string, filePath: string): void {
  if (filePath) attachmentPaths.set(blobUrl, filePath)
}

/** Converte blob URLs dos anexos do input em data URLs estáveis. O input
 * trabalha com blob URLs (URL.createObjectURL) e os REVOGA ao limpar — a fila
 * e o agendamento guardam a mensagem para enviar depois, então precisam da
 * data URL (blob URL revogado vira anexo morto). O envio imediato também usa
 * este caminho (handleSubmit do PromptInput), pela mesma razão: clear() roda
 * antes do submit. Vídeos de arquivo seguem outro caminho: viram um `file://`
 * para o main copiar do disco, em vez de gigabytes de base64 no renderer. */
export async function blobUrlsToDataUrls<T extends { url?: string; mediaType?: string; filename?: string }>(
  files: T[],
): Promise<T[]> {
  return Promise.all(
    files.map(async (item) => {
      if (!item.url?.startsWith("blob:")) return item
      const diskPath = attachmentPaths.get(item.url)
      if (diskPath && isLargeMediaType(item.mediaType, item.filename)) {
        attachmentPaths.delete(item.url)
        return { ...item, url: pathToFileUrl(diskPath) }
      }
      try {
        const blob = await (await fetch(item.url)).blob()
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })
        return { ...item, url: dataUrl ?? item.url }
      } catch {
        return item
      }
    }),
  )
}

/** Ferramentas que tocam a web — alimentam chain-of-thought e fontes. */
export const WEB_TOOLS = new Set(["websearch", "webfetch", "browser_open", "browser_links"])

// `isEngineText`/`lastTextRunStart` moram no shared (@shared/chat-text): o main
// (preview da notificação nativa) e o renderer (bolha, resumo falado) precisam
// da MESMA noção de "resposta final" — e o banner já divergiu dela, anunciando
// a narração do turno. Reexportados para os consumidores daqui não mudarem.
export { isEngineText, lastTextRunStart }

export interface WebSource {
  url: string
  title: string
}

/** Texto completo da mensagem (todas as text parts, incluindo o que foi
 * extraído de anexos). Usado quando o consumidor precisa do conteúdo real —
 * ex.: reenviar em um retry, já que o retry não reanexa o arquivo original. */
export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

/** Só o que a pessoa digitou — omite as text parts com source "attachment"
 * (texto extraído de PDF/planilha/DOCX/skill). Use para exibir a bolha do
 * usuário, copiar a mensagem ou preview no nav: o conteúdo extraído já
 * aparece como chip de anexo, não precisa poluir a bolha com o texto inteiro
 * do arquivo — o modelo continua recebendo tudo via messageText/partText. */
export function visibleMessageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text" && p.source !== "attachment")
    .map((p) => p.text)
    .join("\n")
}

/** Só o corpo da mensagem: sem a citação da mensagem respondida, que a bolha
 *  desenha em destaque. Para previews (navegador de mensagens), onde o trecho
 *  citado só empurraria o texto da pessoa para fora do lugar. */
export function messageBody(message: ChatMessage): string {
  return parseMessageReply(visibleMessageText(message)).body
}

/**
 * Texto que a LEITURA EM VOZ ALTA fala: a resposta final da mensagem, e só ela
 * (só assistente, só prosa do modelo, só o último bloco de texto — sem o JSON
 * do orbit-ui nem o código do diagrama).
 *
 * A regra passou a morar no shared (`@shared/chat-text`): o celular lê a mesma
 * resposta pelo `/api/voice/speak`, e duas cópias divergiriam. Reexportado
 * daqui porque a UI do desktop inteira já importa deste módulo.
 */
export { speakableText } from "@shared/chat-text"

/** Anexo do composer como o conversor precisa vê-lo — o mínimo comum entre o
 *  PromptInputFile, o QueueAttachment e o que volta de um revert. */
export interface AttachmentLike {
  mediaType?: string
  filename?: string
  url?: string
  mediaId?: string
  sourceId?: string
}

/** Converte anexos do PromptInput (FileUIPart, url já em data URL) em FileParts.
 *  `mediaId` marca o anexo que é uma referência à galeria — nesse caso `url` é
 *  só o preview e o main não copia nada (ver FilePart.mediaId). `sourceId` é o
 *  mesmo para uma FONTE da conversa: `url` vazio e o conteúdo já guardado. */
export function toFileParts(files: AttachmentLike[]): FilePart[] {
  return files
    .filter((f): f is AttachmentLike => Boolean(f.url) || Boolean(f.mediaId) || Boolean(f.sourceId))
    .map((f) => ({
      id: `file_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "file" as const,
      mime: f.mediaType ?? "application/octet-stream",
      filename: f.filename,
      url: f.url ?? "",
      ...(f.mediaId ? { mediaId: f.mediaId } : {}),
      ...(f.sourceId ? { sourceId: f.sourceId } : {}),
    }))
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Extrai pares Title/URL da saída textual do websearch (formato Exa). */
export function parseSearchResults(output: string): WebSource[] {
  const sources: WebSource[] = []
  let title: string | null = null
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("Title:")) {
      title = trimmed.slice("Title:".length).trim()
    } else if (trimmed.startsWith("URL:")) {
      const url = trimmed.slice("URL:".length).trim()
      if (url.startsWith("http")) sources.push({ url, title: title ?? hostnameOf(url) })
      title = null
    }
  }
  return sources
}

function sourceOfToolPart(part: ToolPart): WebSource[] {
  if (part.state !== "done") return []
  switch (part.tool) {
    case "websearch":
      return part.output ? parseSearchResults(part.output) : []
    case "webfetch":
    case "browser_open": {
      const url = typeof part.input?.url === "string" ? part.input.url : undefined
      if (!url) return []
      // browser_open retorna "# Título\nURL: ..." na primeira linha
      const heading = part.output?.match(/^#\s+(.+)$/m)?.[1]?.trim()
      return [{ url, title: heading || hostnameOf(url) }]
    }
    default:
      return []
  }
}

/** Fontes consultadas na mensagem (deduplicadas por URL, na ordem de uso). */
export function extractSources(message: ChatMessage): WebSource[] {
  const seen = new Map<string, WebSource>()
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    for (const source of sourceOfToolPart(part)) {
      if (!seen.has(source.url)) seen.set(source.url, source)
    }
  }
  return [...seen.values()]
}

export interface TestSummary {
  passed: number
  failed: number
  skipped: number
  total: number
  duration?: number
}

const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|phpunit|rspec)\b|\bnpm (?:test|t)\b|\b(?:pnpm|yarn|bun) test\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

function parseDurationMs(output: string): number | undefined {
  const jest = output.match(/Time:\s+([\d.]+)\s*s/)
  if (jest) return Math.round(parseFloat(jest[1]) * 1000)
  const pytest = output.match(/in\s+([\d.]+)s\b/)
  if (pytest) return Math.round(parseFloat(pytest[1]) * 1000)
  const vitest = output.match(/Duration\s+([\d.]+)s/)
  if (vitest) return Math.round(parseFloat(vitest[1]) * 1000)
  return undefined
}

/** Extrai o resumo de execução de testes de saídas jest/vitest/pytest. */
export function parseTestSummary(output: string): TestSummary | null {
  const duration = parseDurationMs(output)

  // Jest: "Tests:       1 failed, 2 skipped, 5 passed, 8 total"
  const jest = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+todo,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/,
  )
  if (jest) {
    const failed = Number(jest[1] ?? 0)
    const skipped = Number(jest[2] ?? 0) + Number(jest[3] ?? 0)
    const passed = Number(jest[4] ?? 0)
    return { passed, failed, skipped, total: Number(jest[5]), duration }
  }

  // Vitest: "Tests  1 failed | 5 passed | 1 skipped (7)"
  const vitest = output.match(/Tests\s+((?:\d+\s+\w+(?:\s*\|\s*)?)+)\((\d+)\)/)
  if (vitest) {
    const counts: Record<string, number> = {}
    for (const piece of vitest[1].split("|")) {
      const m = piece.trim().match(/(\d+)\s+(\w+)/)
      if (m) counts[m[2]] = Number(m[1])
    }
    return {
      passed: counts.passed ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
      total: Number(vitest[2]),
      duration,
    }
  }

  // Pytest: "2 failed, 3 passed, 1 skipped in 0.52s"
  const pytest = output.match(/(?:(\d+)\s+failed[,\s]+)?(\d+)\s+passed(?:[,\s]+(\d+)\s+skipped)?\s+in\s+[\d.]+s/)
  if (pytest) {
    const failed = Number(pytest[1] ?? 0)
    const passed = Number(pytest[2])
    const skipped = Number(pytest[3] ?? 0)
    return { passed, failed, skipped, total: passed + failed + skipped, duration }
  }

  return null
}

/**
 * Ordena as partes da resposta para o modo de visualização escolhido.
 *
 * - `summary`: o raciocínio de todos os passos vira um bloco só, no topo, e as
 *   ações que ele separava se juntam num acordeon só. É a leitura de antes:
 *   pensou → resposta → resumo das ações. A narração intermediária ("pensando
 *   alto": o texto anterior ao último bloco) sai da leitura e a resposta final
 *   toma o lugar do primeiro trecho dela — que é como a mensagem ficava antes,
 *   quando o texto final sobrescrevia o primeiro e só ele aparecia. O que a
 *   pessoa não vê aqui continua inteiro em `steps`/`detailed`.
 * - `steps` e `detailed`: cada parte no lugar em que aconteceu; o que muda
 *   entre os dois é só se os blocos vêm recolhidos ou abertos.
 */
export function arrangeForView(parts: MessagePart[], mode: ChatViewMode): MessagePart[] {
  if (mode !== "summary") return parts

  const reasoning = parts.filter((p): p is ReasoningPart => p.type === "reasoning" && p.text.trim() !== "")
  const merged: ReasoningPart | null =
    reasoning.length > 0
      ? {
          id: reasoning[0].id,
          type: "reasoning",
          text: reasoning.map((p) => p.text.trim()).join("\n\n"),
          state: reasoning.some((p) => p.state === "streaming") ? "streaming" : "done",
          durationMs: reasoning.reduce((sum, p) => sum + (p.durationMs ?? 0), 0) || undefined,
        }
      : null

  // Só o texto escrito pelo modelo sem source (a prosa) conta como narração ou
  // resposta: o texto do engine ('nudge'/'todo'/'internal') e o da visão ficam
  // onde estão, com o tratamento que já têm na UI.
  const isProse = (part: MessagePart) => part.type === "text" && part.source === undefined
  const lastRunStart = lastTextRunStart(
    parts.map((part) => ({ kind: "part", part })),
    true,
  )

  const rest: MessagePart[] = []
  let narrationAt = -1
  parts.forEach((part, index) => {
    if (part.type === "reasoning") return
    // Narração intermediária: fora do resumo (o modo passo a passo mostra)
    if (isProse(part) && index < lastRunStart) {
      if (narrationAt === -1) narrationAt = rest.length
      return
    }
    rest.push(part)
  })

  // Sem raciocínio para subir e sem narração para tirar, nada muda
  if (!merged && narrationAt === -1) return parts

  // Sem narração a resposta já está no lugar dela; com narração, sobe para onde
  // o primeiro trecho narrado estava
  const ordered =
    narrationAt === -1
      ? rest
      : [
          ...rest.slice(0, narrationAt).filter((p) => !isProse(p)),
          ...rest.filter(isProse),
          ...rest.slice(narrationAt).filter((p) => !isProse(p)),
        ]

  return merged ? [merged, ...ordered] : ordered
}
