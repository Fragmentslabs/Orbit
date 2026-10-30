import { describe, expect, it } from "vitest"

import { evalCondition, evalNumber, evaluate, interpolate, sampleFn } from "./orbit-expr"

describe("evaluate", () => {
  it("respects precedence and the right-associative ^", () => {
    expect(evaluate("1+2*3", {})).toBe(7)
    expect(evaluate("(1+2)*3", {})).toBe(9)
    expect(evaluate("2^3^2", {})).toBe(512)
    expect(evaluate("-2^2", {})).toBe(-4)
    expect(evaluate("2^-1", {})).toBe(0.5)
  })

  it("reads scope variables and the constants", () => {
    expect(evaluate("capital*(1+juros/100)^anos", { capital: 1000, juros: 10, anos: 2 })).toBeCloseTo(1210)
    expect(evaluate("pi", {})).toBeCloseTo(3.14159, 4)
  })

  it("if evaluates only the chosen branch", () => {
    expect(evaluate("if(n==0, 0, 10/n)", { n: 0 })).toBe(0)
    expect(evaluate("if(n==0, 0, 10/n)", { n: 5 })).toBe(2)
  })

  it("compares and concatenates text", () => {
    expect(evaluate('if(plano=="pro", 29, 9)', { plano: "pro" })).toBe(29)
    expect(evaluate('"a"+"b"', {})).toBe("ab")
    expect(evaluate("on && 1", { on: true })).toBe(true)
  })

  it("financial and utility functions", () => {
    expect(evaluate("round(pmt(0.01, 12, 1000), 2)", {})).toBe(88.85)
    expect(evaluate("clamp(15, 0, 10)", {})).toBe(10)
    expect(evaluate("max(1, 5, 3)", {})).toBe(5)
  })

  it("returns undefined instead of throwing", () => {
    expect(evaluate("1+", {})).toBeUndefined()
    expect(evaluate("naoexiste*2", {})).toBeUndefined()
    expect(evaluate("fetch(1)", {})).toBeUndefined()
    expect(evaluate("a b", { a: 1, b: 2 })).toBeUndefined()
  })

  it("reaches neither the prototype nor globals", () => {
    expect(evaluate("constructor", {})).toBeUndefined()
    expect(evaluate("toString", {})).toBeUndefined()
    expect(evaluate("window", {})).toBeUndefined()
    expect(evaluate("__proto__", {})).toBeUndefined()
    expect(evaluate("hasOwnProperty(1)", {})).toBeUndefined()
  })

  it("rejects a giant expression and deep nesting", () => {
    expect(evaluate("1+".repeat(300) + "1", {})).toBeUndefined()
    expect(evaluate("(".repeat(100) + "1" + ")".repeat(100), {})).toBeUndefined()
  })
})

describe("evalNumber / evalCondition", () => {
  it("accepts a number, an expression and an optional '='", () => {
    expect(evalNumber(5, {})).toBe(5)
    expect(evalNumber("=a*2", { a: 4 })).toBe(8)
    expect(evalNumber("a*2", { a: 4 })).toBe(8)
    expect(evalNumber("1/0", {})).toBeNaN()
    expect(evalNumber("zzz", {})).toBeNaN()
  })

  it("an invalid condition does not hide the block", () => {
    expect(evalCondition(undefined, {})).toBe(true)
    expect(evalCondition("tab==2", { tab: 1 })).toBe(false)
    expect(evalCondition("###", {})).toBe(true)
  })
})

describe("interpolate", () => {
  it("replaces {expr} with the value and respects the format", () => {
    expect(interpolate("Total: {a*2|0}", { a: 21 })).toBe("Total: 42")
    expect(interpolate("{plano}", { plano: "Pro" })).toBe("Pro")
  })

  it("leaves as it is whatever does not evaluate", () => {
    expect(interpolate("use {algo} aqui", {})).toBe("use {algo} aqui")
    expect(interpolate("sem chaves", {})).toBe("sem chaves")
  })

  it("accepts a bare formula when the field is only that", () => {
    expect(interpolate("=a*2", { a: 4 })).toBe("8")
    expect(interpolate("if(a==0, 0, 10/a)|2", { a: 4 })).toMatch(/^2[.,]50$/)
    expect(interpolate("pow(1+t,2)-1|pct", { t: 0.1 })).toMatch(/^0[.,]2%$/)
  })

  it("ordinary text that looks like a word stays text", () => {
    expect(interpolate("Pro", { Pro: 3 })).toBe("Pro")
    expect(interpolate("capital inicial", { capital: 1 })).toBe("capital inicial")
    expect(interpolate("max(a, b) não existe", {})).toBe("max(a, b) não existe")
  })

  it("a non-finite result becomes a dash", () => {
    expect(interpolate("{1/0}", {})).toBe("—")
  })
})

describe("sampleFn", () => {
  it("end-to-end sample using the scope", () => {
    const pts = sampleFn("k*x", 0, 10, 3, { k: 2 })
    expect(pts.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [5, 10],
      [10, 20],
    ])
  })
})
