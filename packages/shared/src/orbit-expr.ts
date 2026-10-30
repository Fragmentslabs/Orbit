/**
 * Expression evaluator of the interactive `orbit-ui` blocks.
 *
 * The model connects components through expressions (`capital*(1+rate/100)^years`), and
 * the one that executes them is THIS file — its own parser, without `eval`, without
 * `new Function` and without access to anything beyond what is in the scope and in the list of
 * functions below. It is what allows content written by a model (which may
 * have read the web in the same turn) to react to clicks without being code.
 *
 * Grammar, from the lowest to the highest precedence:
 *   ||  &&  ==/!=  < <= > >=  + -  * / %  unary(- !)  ^  call/atom
 * `^` is right-associative and stronger than the unary operator (`-2^2` = -4).
 * Values: number, text ("a" or 'a') and boolean (true/false, which become 1/0 in
 * arithmetic). Any error — syntax, variable that does not exist, unknown function
 * — makes the evaluation return `undefined`; the caller decides what to show.
 *
 * This module also runs in React Native: nothing here touches `document`,
 * `navigator` or any screen API. The locale of the formatting comes in as a
 * parameter (`formatValue(…, locale)` / `interpolate(…, locale)`) and the default
 * can be swapped by the host (`setDefaultLocale`).
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

// ── Parser (recursive descent) ──────────────────────────────────────────────

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
      // Exponent: accepts unary (2^-1) and is right-associative.
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

// ── Evaluation ──────────────────────────────────────────────────────────────

const CONSTANTS: Scope = { pi: Math.PI, e: Math.E, true: true, false: false }

const num = (v: Value): number => {
  if (typeof v === "number") return v
  if (typeof v === "boolean") return v ? 1 : 0
  throw new ExprError("not a number")
}

const truthy = (v: Value): boolean => (typeof v === "string" ? v.length > 0 : Boolean(v))

/** `Object.hasOwn` requires lib ES2022; shared compiles with ES2020. */
const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

/** Installment of a loan: pmt(rate per period, periods, present value). */
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
      if (has(scope, node.name)) return scope[node.name]
      if (has(CONSTANTS, node.name)) return CONSTANTS[node.name]
      throw new ExprError(`unknown ${node.name}`)
    }
    case "un": {
      const v = run(node.a, scope)
      return node.op === "-" ? -num(v) : !truthy(v)
    }
    case "call": {
      // `if` is lazy: only the chosen branch is evaluated (allows guarding division by zero).
      if (node.name === "if") {
        if (node.args.length !== 3) throw new ExprError("if args")
        return truthy(run(node.args[0], scope)) ? run(node.args[1], scope) : run(node.args[2], scope)
      }
      if (!has(FUNCTIONS, node.name)) throw new ExprError(`function ${node.name}`)
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

/** Evaluates; `undefined` when the expression is not valid or references something that does not exist. */
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
 * Number coming from the model: it is already a number, or it is an expression (with an optional `=` in
 * front). NaN when it does not result in a finite number.
 */
export function evalNumber(v: number | string | undefined, scope: Scope): number {
  if (typeof v === "number") return v
  if (typeof v !== "string") return NaN
  const result = evaluate(v.replace(/^\s*=/, ""), scope)
  if (typeof result === "boolean") return result ? 1 : 0
  return typeof result === "number" && Number.isFinite(result) ? result : NaN
}

/** Result of a `showIf` condition. An invalid expression does NOT hide the block. */
export function evalCondition(src: string | undefined, scope: Scope): boolean {
  if (!src) return true
  const result = evaluate(src.replace(/^\s*=/, ""), scope)
  if (result === undefined) return true
  return truthy(result)
}

// ── Text with expressions ───────────────────────────────────────────────────

/**
 * Locale used when the caller does not pass one. The product's language is pt-BR, so
 * that is the default; the desktop swaps it for its own screen's on boot
 * (apps/desktop/src/lib/orbit-expr.ts), which is the only place where `document`
 * exists — this module also runs on React Native.
 */
let defaultLocale = "pt-BR"

export function setDefaultLocale(locale: string | undefined): void {
  defaultLocale = locale?.trim() || "pt-BR"
}

export function getDefaultLocale(): string {
  return defaultLocale
}

/**
 * Formats the result of `{expr|fmt}`. fmt: 0-4 (fixed decimal places),
 * `compact` (1.2k), `brl`, `usd`, `eur`, `pct` (number + %). No fmt:
 * up to 2 decimals, with a thousands separator. A missing `locale` uses the host default.
 */
export function formatValue(v: number, fmt?: string, locale?: string): string {
  if (!Number.isFinite(v)) return "—"
  const loc = locale ?? defaultLocale
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
 * Formula written WITHOUT braces in a field that is only it (`"=a*2"`, `"if(a,1,2)|brl"`,
 * `"pow(1+t,12)-1|pct"`). Models forget the braces often, and the
 * result was the formula printed in place of the value. It only applies if the formula
 * starts with `=`, or with a function call, or ends in `|format` — and
 * evaluates: ordinary text ("Pro", "starting capital") stays text.
 */
function bareExpression(text: string, scope: Scope, locale: string): string {
  const trimmed = text.trim()
  const explicit = trimmed.startsWith("=")
  const body = explicit ? trimmed.slice(1) : trimmed
  const fmt = FMT_SUFFIX.exec(body)
  if (!explicit && !fmt && !/^[A-Za-z_]\w*\(/.test(body)) return text
  const result = evaluate(fmt ? body.slice(0, fmt.index) : body, scope)
  if (typeof result === "number") return formatValue(result, fmt?.[1], locale)
  return result === undefined ? text : String(result)
}

/**
 * Replaces each `{expr}` or `{expr|fmt}` in the text with the value. A snippet that
 * does not evaluate (nonexistent variable, syntax) stays as it was: braces in ordinary text
 * cannot turn into "—".
 */
export function interpolate(text: string, scope: Scope, locale?: string): string {
  const loc = locale ?? defaultLocale
  if (!text.includes("{")) return bareExpression(text, scope, loc)
  return text.replace(SEGMENT, (whole, inner: string) => {
    const fmt = FMT_SUFFIX.exec(inner)
    const src = fmt ? inner.slice(0, fmt.index) : inner
    const result = evaluate(src, scope)
    if (result === undefined) return whole
    if (typeof result === "number") return formatValue(result, fmt?.[1], loc)
    return String(result)
  })
}

/** Samples `fn(x)` at `steps` points from `from` to `to` (inclusive). */
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
