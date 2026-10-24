/**
 * Legendas como TEXTO: o caminho barato da transcrição.
 *
 * Quando o site já entrega legenda (o YouTube entrega em quase tudo, manual ou
 * automática), não faz sentido baixar o áudio inteiro e passar pelo motor de
 * ditado — a legenda sai em segundos e é mais fiel, porque vem de onde o
 * próprio site reconheceu a fala. Mas legenda de site não é texto limpo:
 *
 *  - o `.vtt` automático do YouTube é uma JANELA que rola, com a mesma linha
 *    repetida em vários trechos seguidos (sem deduplicar, o texto sai gaguejando);
 *  - vêm tags (`<c>`, `<00:00:01.000>`), entidades HTML e marcação de posição.
 *
 * Este módulo resolve isso e devolve trechos com tempo — o mesmo formato que a
 * transcrição local usa —, para o texto corrido e a lista com timestamps
 * saírem da MESMA leitura.
 */

export interface SubtitleCue {
  startMs: number
  endMs: number
  text: string
}

export type SubtitleFormat = 'json3' | 'vtt' | 'srt' | 'unknown'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (name.startsWith('#')) {
      const code = Number(name.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] ?? whole
  })
}

/** Uma linha de legenda sem marcação: tags, posição ASS, entidades e espaços. */
export function cleanCueLine(line: string): string {
  return decodeEntities(
    line
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\\N/gi, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

export function subtitleFormatOf(file: string, content = ''): SubtitleFormat {
  const ext = file.toLowerCase().split('.').pop() ?? ''
  if (ext === 'json3' || ext === 'json') return 'json3'
  if (ext === 'vtt') return 'vtt'
  if (ext === 'srt' || ext === 'srv') return 'srt'
  const head = content.slice(0, 4000)
  if (/^\s*\{/.test(head)) return 'json3'
  if (/^WEBVTT/m.test(head)) return 'vtt'
  if (head.includes('-->')) return 'srt'
  return 'unknown'
}

/** `00:01:02.345`, `01:02,345`, `62.3s`… tudo em ms. */
export function parseTimestamp(value: string): number | null {
  const text = value.trim()
  const timed = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(text)
  if (timed) {
    const h = timed[1] ? Number(timed[1]) : 0
    const m = Number(timed[2])
    const s = Number(timed[3])
    const ms = Number((timed[4] + '00').slice(0, 3))
    return ((h * 60 + m) * 60 + s) * 1000 + ms
  }
  const bare = /^(\d+(?:[.,]\d+)?)\s*s?$/.exec(text)
  if (bare) return Math.round(Number(bare[1].replace(',', '.')) * 1000)
  return null
}

function parseTimedText(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  // Blocos separados por linha em branco; o cabeçalho WEBVTT e os blocos de
  // estilo (STYLE/NOTE) caem fora por não terem `-->`.
  for (const block of content.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const arrow = lines.findIndex((line) => line.includes('-->'))
    if (arrow < 0) continue
    const [left, right] = lines[arrow].split('-->')
    const startMs = parseTimestamp(left ?? '')
    if (startMs === null) continue
    // O lado direito pode trazer posição depois do tempo ("00:02.000 align:start").
    const endMs = parseTimestamp(right ?? '') ?? startMs
    const body = lines
      .slice(arrow + 1)
      .map(cleanCueLine)
      .filter(Boolean)
    if (!body.length) continue
    cues.push({ startMs, endMs: Math.max(endMs, startMs), text: body.join('\n') })
  }
  return cues
}

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  segs?: { utf8?: string }[]
}

function parseJson3(content: string): SubtitleCue[] {
  let data: { events?: Json3Event[] }
  try {
    data = JSON.parse(content) as { events?: Json3Event[] }
  } catch {
    return []
  }
  const cues: SubtitleCue[] = []
  for (const event of data.events ?? []) {
    const raw = (event.segs ?? []).map((seg) => seg.utf8 ?? '').join('')
    // O json3 marca quebra de linha com um evento só de "\n".
    const text = cleanCueLine(raw)
    if (!text) continue
    const startMs = Math.max(0, Math.round(event.tStartMs ?? 0))
    cues.push({ startMs, endMs: startMs + Math.max(0, Math.round(event.dDurationMs ?? 0)), text })
  }
  return cues
}

export function parseSubtitleFile(content: string, file = ''): SubtitleCue[] {
  const clean = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const format = subtitleFormatOf(file, clean)
  if (format === 'json3') return parseJson3(clean)
  if (format === 'vtt' || format === 'srt') return parseTimedText(clean)
  return []
}

/**
 * As linhas de um trecho que ainda não apareceram nos anteriores — é isto que
 * desfaz a janela rolante do `.vtt` automático (a mesma frase em 3 trechos
 * seguidos vira uma frase só).
 */
function freshLines(cue: SubtitleCue, recent: string[]): string[] {
  return cue.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !recent.includes(line))
}

/** Texto corrido, com parágrafo novo onde a fala descansa (pausa ≥ 1,5 s). */
export function cueText(cues: SubtitleCue[]): string {
  const paragraphs: string[] = []
  let lines: string[] = []
  let recent: string[] = []
  let lastEnd = 0
  const flush = () => {
    if (lines.length) paragraphs.push(lines.join(' '))
    lines = []
    recent = []
  }
  for (const cue of cues) {
    const fresh = freshLines(cue, recent)
    if (!fresh.length) {
      lastEnd = Math.max(lastEnd, cue.endMs)
      continue
    }
    if (lastEnd && cue.startMs - lastEnd > 1500) flush()
    lines.push(...fresh)
    recent = [...recent, ...fresh].slice(-4)
    lastEnd = Math.max(lastEnd, cue.endMs)
  }
  flush()
  return paragraphs.join('\n\n')
}

/** 0:42 / 1:02:09 — o mesmo formato das outras transcrições do app. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Uma linha `[m:ss] texto` por trecho (sem repetir a linha herdada). */
export function timestampedCues(cues: SubtitleCue[]): string {
  const out: string[] = []
  let recent: string[] = []
  for (const cue of cues) {
    const fresh = freshLines(cue, recent)
    if (!fresh.length) continue
    out.push(`[${clockText(cue.startMs)}] ${fresh.join(' ')}`)
    recent = [...recent, ...fresh].slice(-4)
  }
  return out.join('\n')
}

/**
 * Qual idioma usar entre os que o site oferece: primeiro os pedidos (código
 * exato, depois a família — `pt` acha `pt-BR`), depois qualquer um. Devolver o
 * idioma REAL importa: o relatório precisa dizer em que língua o texto saiu.
 */
export function matchLanguage(available: string[], requested: string[]): string | null {
  if (!available.length) return null
  const lower = available.map((lang) => lang.toLowerCase())
  for (const want of requested) {
    const target = want.trim().toLowerCase()
    if (!target) continue
    const exact = lower.indexOf(target)
    if (exact >= 0) return available[exact]
    const family = lower.findIndex((lang) => lang.startsWith(`${target}-`) || lang.startsWith(target))
    if (family >= 0) return available[family]
  }
  return available[0]
}
