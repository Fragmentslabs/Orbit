import { describe, expect, it } from "vitest"

import { evalCondition, evalNumber, evaluate, interpolate, sampleFn } from "./orbit-expr"

describe("evaluate", () => {
  it("respeita a precedência e o ^ à direita", () => {
    expect(evaluate("1+2*3", {})).toBe(7)
    expect(evaluate("(1+2)*3", {})).toBe(9)
    expect(evaluate("2^3^2", {})).toBe(512)
    expect(evaluate("-2^2", {})).toBe(-4)
    expect(evaluate("2^-1", {})).toBe(0.5)
  })

  it("lê variáveis do escopo e as constantes", () => {
    expect(evaluate("capital*(1+juros/100)^anos", { capital: 1000, juros: 10, anos: 2 })).toBeCloseTo(1210)
    expect(evaluate("pi", {})).toBeCloseTo(3.14159, 4)
  })

  it("if só avalia o ramo escolhido", () => {
    expect(evaluate("if(n==0, 0, 10/n)", { n: 0 })).toBe(0)
    expect(evaluate("if(n==0, 0, 10/n)", { n: 5 })).toBe(2)
  })

  it("compara e concatena texto", () => {
    expect(evaluate('if(plano=="pro", 29, 9)', { plano: "pro" })).toBe(29)
    expect(evaluate('"a"+"b"', {})).toBe("ab")
    expect(evaluate("on && 1", { on: true })).toBe(true)
  })

  it("funções financeiras e utilitárias", () => {
    expect(evaluate("round(pmt(0.01, 12, 1000), 2)", {})).toBe(88.85)
    expect(evaluate("clamp(15, 0, 10)", {})).toBe(10)
    expect(evaluate("max(1, 5, 3)", {})).toBe(5)
  })

  it("devolve undefined em vez de lançar", () => {
    expect(evaluate("1+", {})).toBeUndefined()
    expect(evaluate("naoexiste*2", {})).toBeUndefined()
    expect(evaluate("fetch(1)", {})).toBeUndefined()
    expect(evaluate("a b", { a: 1, b: 2 })).toBeUndefined()
  })

  it("não alcança o protótipo nem globais", () => {
    expect(evaluate("constructor", {})).toBeUndefined()
    expect(evaluate("toString", {})).toBeUndefined()
    expect(evaluate("window", {})).toBeUndefined()
    expect(evaluate("__proto__", {})).toBeUndefined()
    expect(evaluate("hasOwnProperty(1)", {})).toBeUndefined()
  })

  it("recusa expressão gigante e aninhamento profundo", () => {
    expect(evaluate("1+".repeat(300) + "1", {})).toBeUndefined()
    expect(evaluate("(".repeat(100) + "1" + ")".repeat(100), {})).toBeUndefined()
  })
})

describe("evalNumber / evalCondition", () => {
  it("aceita número, expressão e '=' opcional", () => {
    expect(evalNumber(5, {})).toBe(5)
    expect(evalNumber("=a*2", { a: 4 })).toBe(8)
    expect(evalNumber("a*2", { a: 4 })).toBe(8)
    expect(evalNumber("1/0", {})).toBeNaN()
    expect(evalNumber("zzz", {})).toBeNaN()
  })

  it("condição inválida não esconde o bloco", () => {
    expect(evalCondition(undefined, {})).toBe(true)
    expect(evalCondition("aba==2", { aba: 1 })).toBe(false)
    expect(evalCondition("###", {})).toBe(true)
  })
})

describe("interpolate", () => {
  it("troca {expr} pelo valor e respeita o formato", () => {
    expect(interpolate("Total: {a*2|0}", { a: 21 })).toBe("Total: 42")
    expect(interpolate("{plano}", { plano: "Pro" })).toBe("Pro")
  })

  it("deixa como está o que não avalia", () => {
    expect(interpolate("use {algo} aqui", {})).toBe("use {algo} aqui")
    expect(interpolate("sem chaves", {})).toBe("sem chaves")
  })

  it("aceita a fórmula solta quando o campo é só ela", () => {
    expect(interpolate("=a*2", { a: 4 })).toBe("8")
    expect(interpolate("if(a==0, 0, 10/a)|2", { a: 4 })).toMatch(/^2[.,]50$/)
    expect(interpolate("pow(1+t,2)-1|pct", { t: 0.1 })).toMatch(/^0[.,]2%$/)
  })

  it("texto comum com cara de palavra continua texto", () => {
    expect(interpolate("Pro", { Pro: 3 })).toBe("Pro")
    expect(interpolate("capital inicial", { capital: 1 })).toBe("capital inicial")
    expect(interpolate("max(a, b) não existe", {})).toBe("max(a, b) não existe")
  })

  it("resultado não finito vira traço", () => {
    expect(interpolate("{1/0}", {})).toBe("—")
  })
})

describe("sampleFn", () => {
  it("amostra de ponta a ponta usando o escopo", () => {
    const pts = sampleFn("k*x", 0, 10, 3, { k: 2 })
    expect(pts.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [5, 10],
      [10, 20],
    ])
  })
})
