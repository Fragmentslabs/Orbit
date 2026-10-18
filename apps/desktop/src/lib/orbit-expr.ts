/**
 * Avaliador de expressões dos blocos `orbit-ui` interativos.
 *
 * O modelo liga componentes por expressões (`capital*(1+juros/100)^anos`), e
 * quem as executa é ESTE arquivo — um parser próprio, sem `eval`, sem
 * `new Function` e sem acesso a nada além do que está no escopo e na lista de
 * funções abaixo. É o que permite um conteúdo escrito por um modelo (que pode
 * ter lido a web no mesmo turno) reagir a cliques sem ser código.
 *
 * Gramática, da menor para a maior precedência:
 *   ||  &&  ==/!=  < <= > >=  + -  * / %  unário(- !)  ^  chamada/átomo
 * `^` é associativo à direita e mais forte que o unário (`-2^2` = -4).
 * Valores: número, texto ("a" ou 'a') e booleano (true/false, que viram 1/0 em
 * conta). Qualquer erro — sintaxe, variável que não existe, função desconhecida
 * — faz a avaliação devolver `undefined`; quem chama decide o que mostrar.
 */

export type Value = number | string | boolean
export type Scope = Record<string, Value>

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; name: string }
  | { k: "un"; op: "-" | "!"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] }

const MAX_LENGTH = 400
const MAX_DEPTH = 40

class ExprError extends Error {}

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Token = { t: "num" | "str" | "id" | "op"; v: string }

const OPERATORS = ["||", "&&", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "^", "!", "(", ")", ","]

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
    } else if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
      if (!m) throw new ExprError("number")
      out.push({ t: "num", v: m[0] })
      i += m[0].length
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1)
      if (end === -1) throw new ExprError("string")
      out.push({ t: "str", v: src.slice(i + 1, end) })
      i = end + 1
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ t: "id", v: m[0] })
      i += m[0].length
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i))
      if (!op) throw new ExprError(`char ${c}`)
      out.push({ t: "op", v: op })
      i += op.length
    }
  }
  return out
}

// ── Parser (descida recursiva) ─────────────────────────────────────────────

const BINARY_LEVELS: string[][] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]]

function parse(tokens: Token[]): Node {
  let pos = 0
  let depth = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => peek()?.t === "op" && peek().v === v
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected ${v}`)
    pos++
  }
  const guard = () => {
    if (++depth > MAX_DEPTH) throw new ExprError("depth")
  }

  function binary(level: number): Node {
    if (level === BINARY_LEVELS.length) return unary()
    let left = binary(level + 1)
    while (peek()?.t === "op" && BINARY_LEVELS[level].includes(peek().v)) {
      const op = tokens[pos++].v
      left = { k: "bin", op, a: left, b: binary(level + 1) }
    }
    return left
  }

  function unary(): Node {
    guard()
    try {
      if (isOp("-") || isOp("!")) {
        const op = tokens[pos++].v as "-" | "!"
        return { k: "un", op, a: unary() }
      }
      return power()
    } finally {
      depth--
    }
  }

  function power(): Node {
    const base = atom()
    if (isOp("^")) {
      pos++
      // Expoente: aceita unário (2^-1) e é associativo à direita.
      return { k: "bin", op: "^", a: base, b: unary() }
    }
    return base
  }

  function atom(): Node {
    const tok = tokens[pos++]
    if (!tok) throw new ExprError("unexpected end")
    if (tok.t === "num") return { k: "num", v: Number(tok.v) }
    if (tok.t === "str") return { k: "str", v: tok.v }
    if (tok.t === "id") {
      if (isOp("(")) {
        pos++
        const args: Node[] = []
        if (!isOp(")")) {
          do args.push(binary(0))
          while (isOp(",") && ++pos)
        }
        expectOp(")")
        return { k: "call", name: tok.v, args }
      }
      return { k: "id", name: tok.v }
    }
    if (tok.v === "(") {
      guard()
      const inner = binary(0)
      depth--
      expectOp(")")
      return inner
    }
    throw new ExprError(`unexpected ${tok.v}`)
  }

  const root = binary(0)
  if (pos < tokens.length) throw new ExprError("trailing")
  return root
}

// ── Avaliação ──────────────────────────────────────────────────────────────

const CONSTANTS: Scope = { pi: Math.PI, e: Math.E, true: true, false: false }

const num = (v: Value): number => {
  if (typeof v === "number") return v
  if (typeof v === "boolean") return v ? 1 : 0
  throw new ExprError("not a number")
}

const truthy = (v: Value): boolean => (typeof v === "string" ? v.length > 0 : Boolean(v))

/** Prestação de um financiamento: pmt(taxa por período, períodos, valor presente). */
const pmt = (rate: number, n: number, pv: number) =>
  rate === 0 ? pv / n : (pv * rate) / (1 - Math.pow(1 + rate, -n))

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  pow: Math.pow,
  round: (x, d = 0) => {
    const f = Math.pow(10, d)
    return Math.round(x * f) / f
  },
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  sum: (...a) => a.reduce((s, x) => s + x, 0),
  avg: (...a) => a.reduce((s, x) => s + x, 0) / a.length,
  pmt,
}

function run(node: Node, scope: Scope): Value {
  switch (node.k) {
    case "num":
    case "str":
      return node.v
    case "id": {
      if (Object.hasOwn(scope, node.name)) return scope[node.name]
      if (Object.hasOwn(CONSTANTS, node.name)) return CONSTANTS[node.name]
      throw new ExprError(`unknown ${node.name}`)
    }
    case "un": {
      const v = run(node.a, scope)
      return node.op === "-" ? -num(v) : !truthy(v)
    }
    case "call": {
      // `if` é preguiçoso: só o ramo escolhido é avaliado (permite guardar divisão por zero).
      if (node.name === "if") {
        if (node.args.length !== 3) throw new ExprError("if args")
        return truthy(run(node.args[0], scope)) ? run(node.args[1], scope) : run(node.args[2], scope)
      }
      if (!Object.hasOwn(FUNCTIONS, node.name)) throw new ExprError(`function ${node.name}`)
      return FUNCTIONS[node.name](...node.args.map((a) => num(run(a, scope))))
    }
    case "bin": {
      if (node.op === "&&") return truthy(run(node.a, scope)) && truthy(run(node.b, scope))
      if (node.op === "||") return truthy(run(node.a, scope)) || truthy(run(node.b, scope))
      const a = run(node.a, scope)
      const b = run(node.b, scope)
      switch (node.op) {
        case "==":
          return a === b || (typeof a !== "string" && typeof b !== "string" && num(a) === num(b))
        case "!=":
          return !(a === b || (typeof a !== "string" && typeof b !== "string" && num(a) === num(b)))
        case "+":
          return typeof a === "string" || typeof b === "string" ? `${a}${b}` : num(a) + num(b)
        case "<":
          return num(a) < num(b)
        case "<=":
          return num(a) <= num(b)
        case ">":
          return num(a) > num(b)
        case ">=":
          return num(a) >= num(b)
        case "-":
          return num(a) - num(b)
        case "*":
          return num(a) * num(b)
        case "/":
          return num(a) / num(b)
        case "%":
          return num(a) % num(b)
        case "^":
          return Math.pow(num(a), num(b))
      }
      throw new ExprError(`op ${node.op}`)
    }
  }
}

const compiled = new Map<string, Node | null>()
const CACHE_LIMIT = 500

function compile(src: string): Node | null {
  if (compiled.has(src)) return compiled.get(src)!
  let node: Node | null = null
  if (src.length <= MAX_LENGTH) {
    try {
      node = parse(tokenize(src))
    } catch {
      node = null
    }
  }
  if (compiled.size >= CACHE_LIMIT) compiled.delete(compiled.keys().next().value!)
  compiled.set(src, node)
  return node
}

/** Avalia; `undefined` quando a expressão não é válida ou referencia o que não existe. */
export function evaluate(src: string, scope: Scope): Value | undefined {
  const node = compile(src.trim())
  if (!node) return undefined
  try {
    return run(node, scope)
  } catch {
    return undefined
  }
}

/**
 * Número vindo do modelo: já é número, ou é uma expressão (com `=` opcional na
 * frente). NaN quando não resulta em número finito.
 */
export function evalNumber(v: number | string | undefined, scope: Scope): number {
  if (typeof v === "number") return v
  if (typeof v !== "string") return NaN
  const result = evaluate(v.replace(/^\s*=/, ""), scope)
  if (typeof result === "boolean") return result ? 1 : 0
  return typeof result === "number" && Number.isFinite(result) ? result : NaN
}

/** Resultado de uma condição `showIf`. Expressão inválida NÃO esconde o bloco. */
export function evalCondition(src: string | undefined, scope: Scope): boolean {
  if (!src) return true
  const result = evaluate(src.replace(/^\s*=/, ""), scope)
  if (result === undefined) return true
  return truthy(result)
}

// ── Texto com expressões ───────────────────────────────────────────────────

const locale = () =>
  (typeof document !== "undefined" && document.documentElement.lang) ||
  (typeof navigator !== "undefined" && navigator.language) ||
  "pt-BR"

/**
 * Formata o resultado de `{expr|fmt}`. fmt: 0-4 (casas decimais fixas),
 * `compact` (1,2 mil), `brl`, `usd`, `eur`, `pct` (número + %). Sem fmt:
 * até 2 casas, com separador de milhar.
 */
export function formatValue(v: number, fmt?: string): string {
  if (!Number.isFinite(v)) return "—"
  const loc = locale()
  if (fmt && /^[0-4]$/.test(fmt)) {
    const d = Number(fmt)
    return new Intl.NumberFormat(loc, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v)
  }
  if (fmt === "compact") return new Intl.NumberFormat(loc, { notation: "compact", maximumFractionDigits: 1 }).format(v)
  if (fmt === "brl" || fmt === "usd" || fmt === "eur") {
    return new Intl.NumberFormat(loc, { style: "currency", currency: fmt.toUpperCase() }).format(v)
  }
  if (fmt === "pct") return `${new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(v)}%`
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(v)
}

const SEGMENT = /\{([^{}]+)\}/g
const FMT_SUFFIX = /\|(\d|compact|brl|usd|eur|pct)\s*$/

/**
 * Fórmula escrita SEM chaves num campo que é só ela (`"=a*2"`, `"if(a,1,2)|brl"`,
 * `"pow(1+t,12)-1|pct"`). Modelos esquecem as chaves com frequência, e o
 * resultado era a fórmula impressa no lugar do valor. Só vale se a fórmula
 * começa com `=`, ou com uma chamada de função, ou termina em `|formato` — e
 * avalia: texto comum ("Pro", "capital inicial") continua texto.
 */
function bareExpression(text: string, scope: Scope): string {
  const trimmed = text.trim()
  const explicit = trimmed.startsWith("=")
  const body = explicit ? trimmed.slice(1) : trimmed
  const fmt = FMT_SUFFIX.exec(body)
  if (!explicit && !fmt && !/^[A-Za-z_]\w*\(/.test(body)) return text
  const result = evaluate(fmt ? body.slice(0, fmt.index) : body, scope)
  if (typeof result === "number") return formatValue(result, fmt?.[1])
  return result === undefined ? text : String(result)
}

/**
 * Substitui cada `{expr}` ou `{expr|fmt}` do texto pelo valor. Um trecho que
 * não avalia (variável inexistente, sintaxe) fica como estava: chaves num texto
 * comum não podem virar "—".
 */
export function interpolate(text: string, scope: Scope): string {
  if (!text.includes("{")) return bareExpression(text, scope)
  return text.replace(SEGMENT, (whole, inner: string) => {
    const fmt = FMT_SUFFIX.exec(inner)
    const src = fmt ? inner.slice(0, fmt.index) : inner
    const result = evaluate(src, scope)
    if (result === undefined) return whole
    if (typeof result === "number") return formatValue(result, fmt?.[1])
    return String(result)
  })
}

/** Amostra `fn(x)` em `steps` pontos de `from` a `to` (inclusive). */
export function sampleFn(
  fn: string,
  from: number,
  to: number,
  steps: number,
  scope: Scope,
): { x: number; y: number }[] {
  const n = Math.max(2, Math.min(200, Math.round(steps)))
  const points: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const x = from + ((to - from) * i) / (n - 1)
    points.push({ x, y: evalNumber(fn, { ...scope, x }) })
  }
  return points
}
