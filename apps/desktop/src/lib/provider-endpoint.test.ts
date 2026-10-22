import { describe, expect, it } from "vitest"

import { isLocalEndpoint } from "@/src/lib/provider-endpoint"

/**
 * A UI agrupa os provedores personalizados por este helper. Um erro aqui não
 * quebra nada — só coloca um servidor na seção errada, que é justamente a
 * confusão que o agrupamento existe para resolver.
 */

describe("isLocalEndpoint", () => {
  it("reconhece loopback em todas as formas", () => {
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true)
    expect(isLocalEndpoint("http://LOCALHOST:11434/v1")).toBe(true)
    expect(isLocalEndpoint("http://localhost:11434/v1/")).toBe(true)
    expect(isLocalEndpoint("http://127.0.0.1:8000/v1")).toBe(true)
    expect(isLocalEndpoint("http://127.1.2.3:5000/v1")).toBe(true)
    expect(isLocalEndpoint("http://[::1]:1234/v1")).toBe(true)
    expect(isLocalEndpoint("http://api.localhost:8080/v1")).toBe(true)
    expect(isLocalEndpoint("http://localhost./v1")).toBe(true)
  })

  it("trata outras máquinas como remotas, inclusive na LAN", () => {
    expect(isLocalEndpoint("https://api.exemplo.com/v1")).toBe(false)
    expect(isLocalEndpoint("http://192.168.1.10:11434/v1")).toBe(false)
    expect(isLocalEndpoint("http://mac-mini.local:1234/v1")).toBe(false)
    expect(isLocalEndpoint("https://openrouter.ai/api/v1")).toBe(false)
  })

  it("sem URL válida, cai no grupo dos remotos", () => {
    expect(isLocalEndpoint(undefined)).toBe(false)
    expect(isLocalEndpoint("")).toBe(false)
    expect(isLocalEndpoint("nao-e-uma-url")).toBe(false)
  })
})
