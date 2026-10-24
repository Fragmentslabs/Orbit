import path from 'node:path'

/**
 * Reconhece o `bash` que só LÊ ou BUSCA — `cat`, `sed -n`, `head`, `grep`,
 * `rg`, `find`, `ls` — para que ele receba o mesmo tratamento do `read` e do
 * `grep` no corte de contexto (context-budget.ts) e para a tool apontar o
 * índice de símbolos quando a busca é por um nome.
 *
 * Nos dados reais, depois do code-index, 62% das chamadas de bash eram
 * leitura ou busca: passavam por fora do índice e, como bash não é
 * idempotente, nenhum desses resultados era descartado quando repetido.
 *
 * Conservador de propósito: qualquer coisa que possa escrever (redirecionamento,
 * `sed -i`, `find -exec`, encadeamento com `;`/`&&`, substituição de comando)
 * não é inspeção. Errar para "não é" só mantém o comportamento de antes.
 * Módulo puro, sem IO.
 */

/** Comandos que, sozinhos ou num pipe entre eles, só leem. */
const INSPECT_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'wc', 'grep', 'rg', 'find', 'ls', 'sort', 'uniq', 'cut', 'tr'])

/** `cd dir && ` no começo: o resto roda a partir de `dir`. */
const LEADING_CD = /^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/

const STDERR_ONLY = /\s2>(\/dev\/null|&1)(?=\s|\||$)/g

export interface InspectCommand {
  /** Pasta onde o comando roda, absoluta */
  cwd: string
  /** O comando sem o `cd` inicial, com espaços normalizados */
  command: string
}

export interface FileView {
  /** Caminho absoluto do arquivo lido */
  path: string
  /** Primeira e última linha mostradas (1-indexed, inclusivas) */
  from: number
  to: number
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token.at(-1) === token[0]) {
    return token.slice(1, -1)
  }
  return token
}

/** Divide em palavras respeitando aspas simples e duplas. */
function words(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

/**
 * O comando, quando ele é só leitura/busca; null quando pode ter efeito
 * colateral ou não dá para ter certeza.
 */
export function parseInspection(command: string, directory: string): InspectCommand | null {
  let rest = command.trim()
  let cwd = directory
  for (let match = LEADING_CD.exec(rest); match; match = LEADING_CD.exec(rest)) {
    cwd = path.resolve(cwd, unquote(match[1]))
    rest = rest.slice(match[0].length)
  }
  // Sem aspas no meio, para os testes abaixo não confundirem um `>` dentro de
  // um padrão de grep com redirecionamento — o que sobra é a estrutura.
  // `2>/dev/null` e `2>&1` são o único redirecionamento aceito: só calam ou
  // juntam o stderr, nunca escrevem arquivo.
  const bare = rest.replace(/"[^"]*"|'[^']*'/g, '""').replace(STDERR_ONLY, '')
  if (!rest || /[;&><`\n]|\$\(/.test(bare)) return null
  for (const segment of bare.split('|')) {
    const [name, ...args] = words(segment.trim())
    if (!name || !INSPECT_COMMANDS.has(name)) return null
    if (name === 'sed' && args.some((a) => a.startsWith('-i') || a === '--in-place')) return null
    if (name === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fls)/.test(a))) return null
  }
  return { cwd, command: rest.replace(STDERR_ONLY, '').replace(/\s+/g, ' ').trim() }
}

/**
 * O trecho de arquivo que um `cat`/`nl`/`head`/`sed -n 'A,Bp'` mostra, quando
 * é um comando só, sobre um arquivo só. `tail` fica de fora: a faixa depende
 * do tamanho do arquivo, que daqui não se sabe.
 */
export function parseFileView(inspection: InspectCommand): FileView | null {
  if (inspection.command.includes('|')) return null
  const [name, ...args] = words(inspection.command).map(unquote)
  const file = (value: string | undefined) =>
    value && !/[*?[\]{}~$]/.test(value) ? path.resolve(inspection.cwd, value) : null

  if (name === 'cat' || name === 'nl') {
    const files = args.filter((a) => !a.startsWith('-'))
    const target = files.length === 1 ? file(files[0]) : null
    return target ? { path: target, from: 1, to: Infinity } : null
  }
  if (name === 'head') {
    let lines = 10
    const files: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-n') lines = Number(args[++i])
      else if (/^-n\d+$/.test(arg)) lines = Number(arg.slice(2))
      else if (/^-\d+$/.test(arg)) lines = Number(arg.slice(1))
      else if (arg.startsWith('-')) return null
      else files.push(arg)
    }
    const target = files.length === 1 ? file(files[0]) : null
    return target && Number.isFinite(lines) && lines > 0 ? { path: target, from: 1, to: lines } : null
  }
  if (name === 'sed') {
    if (args.length !== 3 || args[0] !== '-n') return null
    const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1])
    const target = file(args[2])
    if (!range || !target) return null
    const from = Number(range[1])
    const to = range[2] ? Number(range[2]) : from
    return from > 0 && to >= from ? { path: target, from, to } : null
  }
  return null
}

/**
 * O padrão de um `grep`/`rg` que procura um NOME (identificador, `a.b`), não
 * texto livre — é a busca que o code_search/code_refs respondem melhor.
 */
export function symbolSearchPattern(inspection: InspectCommand): string | null {
  const [name, ...args] = words(inspection.command.split('|')[0].trim()).map(unquote)
  if (name !== 'grep' && name !== 'rg') return null
  const pattern = args.find((a) => !a.startsWith('-'))
  if (!pattern) return null
  const bare = pattern.replace(/^\\b|\\b$/g, '')
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(bare) && bare.length >= 3 ? bare : null
}
