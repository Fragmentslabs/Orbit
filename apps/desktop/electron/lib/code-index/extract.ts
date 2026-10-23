import path from 'node:path'
import type { SyntaxNode } from '@lezer/common'
import { languageFor, parserFor, type DefRule, type LezerSpec, type SymbolKind } from './languages'

/**
 * O que um arquivo declara e o que ele usa. É a unidade que o índice guarda
 * (e persiste) por arquivo; o grafo de quem-chama-quem é derivado disso no
 * momento da consulta, nunca salvo — assim mudar um arquivo só exige
 * re-extrair aquele arquivo.
 */

export interface SymbolDef {
  name: string
  /** Nome qualificado pelo escopo: `Classe.metodo`, `Tipo.Metodo` (Go), `S.m` (impl do Rust). */
  qual: string
  kind: SymbolKind
  /** Linhas 1-based, inclusivas. */
  line: number
  end: number
  /** Índice da definição que contém esta, -1 no topo do arquivo. */
  parent: number
  /** Cabeçalho da definição em uma linha (até o corpo). */
  sig: string
  /** Comentário logo acima — entra na busca, não na saída. */
  doc: string
  /** Faz parte da API pública do arquivo (export, pub, public, nome exportado em Go). */
  exported?: true
}

/** Como o nome foi usado: chamada/valor simples, acesso a membro (`x.foo`) ou tipo (`: Foo`). */
export const enum UseKind {
  Plain = 0,
  Member = 1,
  Type = 2,
}

/** [nome usado, índice da definição onde o uso está (-1 = topo do arquivo), linha, tipo de uso] */
export type SymbolUse = [name: string, owner: number, line: number, kind: UseKind]

export interface FileFacts {
  lang: string
  lines: number
  defs: SymbolDef[]
  uses: SymbolUse[]
  /** Especificadores de import (JS/TS) — desempatam nomes repetidos. */
  imports: string[]
  /** Nome ligado por import → de onde veio: o `helper` daqui é o do arquivo importado. */
  importNames: Array<[name: string, spec: string]>
  /** Nomes ligados localmente (parâmetros, variáveis locais): sombreiam homônimos de outros arquivos. */
  locals: string[]
}

const MAX_SIG = 200
const MAX_DOC = 240
/** Linhas guardadas por (quem usa, nome): o bastante para listar cada chamada sem inchar o índice. */
const MAX_LINES_PER_USE = 30

/** Palavras que os extratores de linha confundiriam com identificador. */
const NOISE = new Set([
  'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint', 'undefined', 'length',
  'if', 'else', 'for', 'while', 'return', 'true', 'false', 'null', 'nil', 'self', 'this', 'super',
  'new', 'let', 'var', 'val', 'const', 'func', 'fun', 'def', 'end', 'do', 'in', 'is', 'as', 'of',
  'and', 'or', 'not', 'try', 'catch', 'throw', 'throws', 'import', 'from', 'class', 'struct',
  'public', 'private', 'protected', 'static', 'override', 'void', 'int', 'string', 'bool', 'none',
])

export async function extractFacts(filePath: string, source: string): Promise<FileFacts | null> {
  const handler = languageFor(path.extname(filePath))
  if (!handler) return null
  const lineStarts = computeLineStarts(source)
  if (handler.type === 'line') return extractByLines(handler.id, source, lineStarts.length)
  const parser = await parserFor(handler.spec)
  return extractWithTree(handler.spec, parser.parse(source).topNode, source, lineStarts)
}

function computeLineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

interface Frame {
  from: number
  to: number
  type: string
  /** Índice da definição (ou -1 para container, que só qualifica). */
  def: number
  name: string
}

function extractWithTree(spec: LezerSpec, top: SyntaxNode, source: string, starts: number[]): FileFacts {
  const defs: SymbolDef[] = []
  const uses: SymbolUse[] = []
  const imports: string[] = []
  const importNames: Array<[string, string]> = []
  const locals = new Set<string>()
  let currentImport: { to: number; spec: string } | null = null
  const seenUse = new Set<string>()
  const useCount = new Map<string, number>()
  const nameNodes = new Set<number>()
  const frames: Frame[] = []
  let scopeDepth = 0
  const lines = source.split('\n')
  const cursor = top.cursor()

  const ownerDef = () => {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].def >= 0) return frames[i].def
    return -1
  }

  const enter = (node: SyntaxNode) => {
    const rule = spec.defs[node.name]
    if (rule && (!rule.topLevel || scopeDepth === 0) && matchesRequirement(node, rule)) {
      const nameNode = findName(node, rule, spec)
      if (nameNode) {
        nameNodes.add(nameNode.from)
        const name = source.slice(nameNode.from, nameNode.to)
        const scope = frames.map((f) => f.name)
        if (rule.receiver) {
          const receiver = receiverType(node, rule.receiver, source)
          if (receiver) scope.push(receiver)
        }
        if (rule.container) {
          frames.push({ from: node.from, to: node.to, type: node.name, def: -1, name })
        } else {
          const parent = ownerDef()
          let kind = kindFor(node, rule)
          if (kind === 'function' && parent >= 0 && isTypeLike(defs[parent].kind)) kind = 'method'
          const line = lineAt(starts, node.from)
          const sig = signature(node, spec, source)
          defs.push({
            name,
            qual: [...scope, name].join('.'),
            kind,
            line,
            end: lineAt(starts, Math.max(node.from, node.to - 1)),
            parent,
            sig,
            doc: docAbove(lines, line - 1),
            ...(isExported(spec.id, node, name, sig, parent) ? { exported: true as const } : {}),
          })
          frames.push({ from: node.from, to: node.to, type: node.name, def: defs.length - 1, name })
        }
      }
    }
    if (spec.scopes.has(node.name)) scopeDepth++
    if (currentImport && node.from >= currentImport.to) currentImport = null
    if (isBinding(spec, node) && !nameNodes.has(node.from)) {
      const name = source.slice(node.from, node.to)
      if (currentImport) importNames.push([name, currentImport.spec])
      else locals.add(name)
      return
    }
    if (spec.refs.has(node.name) && !nameNodes.has(node.from)) {
      const name = source.slice(node.from, node.to)
      if (name.length > 1 && !NOISE.has(name)) {
        const owner = ownerDef()
        const kind = kindOfUse(spec, node)
        // Cada linha conta: `createVideoTools` chama resolveSafePath em 11
        // lugares, e o agente precisa de todos — não só do primeiro.
        const line = lineAt(starts, node.from)
        const key = `${owner}\0${kind}\0${name}`
        const lineKey = `${key}\0${line}`
        const count = useCount.get(key) ?? 0
        if (!seenUse.has(lineKey) && count < MAX_LINES_PER_USE) {
          seenUse.add(lineKey)
          useCount.set(key, count + 1)
          uses.push([name, owner, line, kind])
        }
      }
    }
    if (spec.imports?.has(node.name)) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'String') continue
        const spec = source.slice(child.from + 1, child.to - 1)
        imports.push(spec)
        currentImport = { to: node.to, spec }
      }
    }
  }

  const leave = (node: SyntaxNode) => {
    if (spec.scopes.has(node.name)) scopeDepth--
    const top = frames[frames.length - 1]
    if (top && top.from === node.from && top.to === node.to && top.type === node.name) frames.pop()
  }

  // Caminhada iterativa: recursão estoura a pilha em arquivo gerado gigante.
  for (;;) {
    enter(cursor.node)
    if (cursor.firstChild()) continue
    for (;;) {
      leave(cursor.node)
      if (cursor.nextSibling()) break
      if (!cursor.parent()) {
        return { lang: spec.id, lines: starts.length, defs, uses, imports, importNames, locals: [...locals] }
      }
    }
  }
}

/**
 * API pública por convenção de cada linguagem. Sem regra (C/C++), nada é
 * marcado — o outline não afirma o que não sabe.
 */
function isExported(lang: string, node: SyntaxNode, name: string, sig: string, parent: number): boolean {
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      return node.parent?.name === 'ExportDeclaration'
    case 'go':
      return parent < 0 && /^[A-Z]/.test(name)
    case 'rust':
      return /^pub\b/.test(sig)
    case 'java':
      return /\bpublic\b/.test(sig)
    case 'php':
      return !/\b(private|protected)\b/.test(sig)
    case 'python':
      return parent < 0 && !name.startsWith('_')
    default:
      return false
  }
}

function isBinding(spec: LezerSpec, node: SyntaxNode): boolean {
  if (spec.bindings?.has(node.name)) return true
  return Boolean(spec.bindingParents && node.parent && spec.bindingParents.has(node.parent.name) && spec.refs.has(node.name))
}

function kindOfUse(spec: LezerSpec, node: SyntaxNode): UseKind {
  if (spec.types?.has(node.name)) return UseKind.Type
  if (spec.members?.has(node.name)) return UseKind.Member
  if (spec.memberParents && node.parent && spec.memberParents.has(node.parent.name) && node.prevSibling) {
    return UseKind.Member
  }
  return UseKind.Plain
}

function matchesRequirement(node: SyntaxNode, rule: DefRule): boolean {
  if (!rule.requires) return true
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === rule.requires) return true
  }
  return false
}

function kindFor(node: SyntaxNode, rule: DefRule): SymbolKind {
  if (!rule.kindByChild) return rule.kind
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const kind = rule.kindByChild[child.name]
    if (kind) return kind
  }
  return rule.kind
}

const isTypeLike = (kind: SymbolKind) => kind === 'class' || kind === 'interface' || kind === 'enum'

/** Primeiro (ou último) nó de nome, sem descer em corpo, parâmetros ou tipos. */
function findName(node: SyntaxNode, rule: DefRule, spec: LezerSpec): SyntaxNode | null {
  let found: SyntaxNode | null = null
  const visit = (parent: SyntaxNode, depth: number): boolean => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (rule.name.includes(child.name)) {
        found = child
        if (!rule.lastName) return true
        continue
      }
      if (depth < 3 && !spec.bodies.has(child.name) && !spec.skip.has(child.name) && !spec.defs[child.name]) {
        if (visit(child, depth + 1)) return true
      }
    }
    return false
  }
  visit(node, 0)
  return found
}

function receiverType(node: SyntaxNode, childType: string, source: string): string | null {
  const params = node.getChild(childType)
  if (!params) return null
  const search = (parent: SyntaxNode): string | null => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TypeName') return source.slice(child.from, child.to)
      const inner = search(child)
      if (inner) return inner
    }
    return null
  }
  return search(params)
}

function signature(node: SyntaxNode, spec: LezerSpec, source: string): string {
  // `export function f` — o export faz parte do que o agente precisa saber.
  const start = node.parent?.name === 'ExportDeclaration' ? node.parent.from : node.from
  let end = node.to
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (spec.bodies.has(child.name)) {
      end = child.from
      break
    }
  }
  const text = source.slice(start, Math.min(end, start + MAX_SIG * 3)).replace(/\s+/g, ' ').trim()
  return text.length > MAX_SIG ? `${text.slice(0, MAX_SIG)}…` : text
}

const COMMENT_LINE = /^\s*(\/\/\/?|#(?!include|define|if|endif|pragma)|\*|\/\*\*?|\*\/|--)/

function docAbove(lines: string[], index: number): string {
  const parts: string[] = []
  let i = index - 1
  // Decorators/annotations ficam entre o comentário e a definição.
  while (i >= 0 && /^\s*@/.test(lines[i])) i--
  for (let n = 0; i >= 0 && n < 8; i--, n++) {
    if (!COMMENT_LINE.test(lines[i])) break
    const text = lines[i].replace(COMMENT_LINE, '').replace(/\*\/\s*$/, '').trim()
    if (text) parts.unshift(text)
  }
  const doc = parts.join(' ')
  return doc.length > MAX_DOC ? doc.slice(0, MAX_DOC) : doc
}

const LINE_DEF =
  /^(\s*)(?:(?:public|private|protected|internal|open|override|static|abstract|final|async|export|inline|suspend|data|sealed|fileprivate|partial|virtual|readonly|unsafe|extern|mutating|local|@\w+(?:\([^)]*\))?)\s+)*(func|fun|function|def|defp|defmodule|defmacro|class|struct|interface|protocol|enum|trait|object|module|record|extension|typealias)\s+([A-Za-z_][\w]*[?!]?)/

const LINE_KIND: Record<string, SymbolKind> = {
  func: 'function', fun: 'function', function: 'function', def: 'function', defp: 'function', defmacro: 'function',
  class: 'class', struct: 'class', object: 'class', record: 'class', extension: 'class',
  interface: 'interface', protocol: 'interface', trait: 'interface',
  enum: 'enum', module: 'module', defmodule: 'module', typealias: 'type',
}

/**
 * Extrator de linha: definição por regex, fim pela indentação (a próxima linha
 * não vazia com indentação ≤ à da definição). Uso = qualquer identificador,
 * filtrado depois pelo grafo contra os nomes que existem de fato.
 */
function extractByLines(lang: string, source: string, lineCount: number): FileFacts {
  const lines = source.split('\n')
  const defs: SymbolDef[] = []
  const open: Array<{ def: number; indent: number }> = []
  const closeUntil = (indent: number, line: number) => {
    while (open.length > 0 && open[open.length - 1].indent >= indent) {
      const frame = open.pop()!
      defs[frame.def].end = Math.max(defs[frame.def].line, line)
    }
  }

  let lastCode = 0
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text.trim() || COMMENT_LINE.test(text)) continue
    const indent = text.length - text.trimStart().length
    // `}`/`end` fecha o bloco na própria linha; qualquer outra linha no mesmo
    // nível fecha na última linha de código antes dela.
    const closesBlock = /^\s*(\}|end\b)/.test(text)
    closeUntil(indent, closesBlock ? i + 1 : lastCode)
    lastCode = i + 1
    const match = LINE_DEF.exec(text)
    if (!match) continue
    const parent = open.length > 0 ? open[open.length - 1].def : -1
    let kind = LINE_KIND[match[2]] ?? 'function'
    if (kind === 'function' && parent >= 0 && isTypeLike(defs[parent].kind)) kind = 'method'
    const name = match[3]
    defs.push({
      name,
      qual: parent >= 0 ? `${defs[parent].qual}.${name}` : name,
      kind,
      line: i + 1,
      end: i + 1,
      parent,
      sig: text.trim().replace(/\s*[{:=]\s*$/, '').slice(0, MAX_SIG),
      doc: docAbove(lines, i),
      ...(/\b(public|open|export|pub)\b/.test(text) ? { exported: true as const } : {}),
    })
    open.push({ def: defs.length - 1, indent })
  }
  closeUntil(-1, lastCode)

  const uses: SymbolUse[] = []
  const seen = new Set<string>()
  const ownerAt = (line: number) => {
    let owner = -1
    for (let d = 0; d < defs.length && defs[d].line <= line; d++) if (defs[d].end >= line) owner = d
    return owner
  }
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT_LINE.test(lines[i])) continue
    const code = lines[i].replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')
    let owner: number | null = null
    for (const match of code.matchAll(/[A-Za-z_]\w*/g)) {
      const name = match[0]
      if (name.length < 2 || NOISE.has(name)) continue
      owner ??= ownerAt(i + 1)
      const key = `${owner}\0${name}\0${i}`
      if (seen.has(key)) continue
      seen.add(key)
      // Sem árvore não dá para separar membro de chamada: `.foo` vira membro
      // pelo ponto antes do nome, o resto fica simples.
      const kind = match.index! > 0 && code[match.index! - 1] === '.' ? UseKind.Member : UseKind.Plain
      uses.push([name, owner, i + 1, kind])
    }
  }
  // O identificador na linha da própria definição não é uso dela.
  const defSites = new Set(defs.map((d) => `${d.line}\0${d.name}`))
  const filtered = uses.filter(([name, , line]) => !defSites.has(`${line}\0${name}`))
  return { lang, lines: lineCount, defs, uses: filtered, imports: [], importNames: [], locals: [] }
}
