import { describe, expect, it } from "vitest"
import type { AppSettings } from "@shared/app-settings"
import {
  appendDictation,
  pcm16ToBase64,
  pcmWorkletUrl,
  parseVoiceStatus,
  resolveVoiceSttSettings,
  voiceTargetReady,
} from "./dictation"

/** AppSettings sem o bloco `voice` (localStorage de uma versão anterior). */
const semVoz = {} as AppSettings

/** AppSettings com o bloco, do jeito que o objeto cru chegaria do localStorage. */
const comVoz = (stt: Record<string, unknown>) => ({ voice: { stt } }) as unknown as AppSettings

describe("resolveVoiceSttSettings", () => {
  it("bloco ausente cai nos padrões do produto", () => {
    expect(resolveVoiceSttSettings(semVoz)).toEqual({
      enabled: true,
      engine: "parakeet",
      modelId: null,
      language: "pt",
      live: true,
      threads: 4,
      preload: true,
    })
  })

  it("lê o que o usuário escolheu", () => {
    const voice = resolveVoiceSttSettings(
      comVoz({
        enabled: false,
        engine: "whisper",
        modelId: "small",
        language: "en",
        live: false,
        threads: 8,
        preload: false,
      }),
    )
    expect(voice).toEqual({
      enabled: false,
      engine: "whisper",
      modelId: "small",
      language: "en",
      live: false,
      threads: 8,
      preload: false,
    })
  })

  it("valores de tipo errado não vazam para o motor", () => {
    const voice = resolveVoiceSttSettings(
      comVoz({ enabled: "sim", engine: 42, modelId: "", language: null, live: "on", threads: NaN, preload: "sim" }),
    )
    expect(voice).toEqual({
      enabled: true,
      engine: "parakeet",
      modelId: null,
      language: "pt",
      live: true,
      threads: 4,
      preload: true,
    })
  })

  it("null e undefined não lançam", () => {
    expect(resolveVoiceSttSettings(null).engine).toBe("parakeet")
    expect(resolveVoiceSttSettings(undefined).enabled).toBe(true)
  })
})

describe("parseVoiceStatus", () => {
  it("aceita modelos como mapa por id (a forma do canal)", () => {
    const status = parseVoiceStatus({
      engines: [{ id: "parakeet", available: true, installed: true }, { engine: "whisper", available: false }],
      models: { small: { installed: true, engine: "whisper" }, parakeet: { installed: false } },
    })
    expect(status).toEqual({
      engines: [
        { id: "parakeet", available: true, downloaded: true },
        { id: "whisper", engine: "whisper", available: false },
      ],
      models: [
        { id: "small", engine: "whisper", downloaded: true },
        { id: "parakeet", downloaded: false },
      ],
    })
  })

  it("aceita listas de objetos e de strings", () => {
    const status = parseVoiceStatus({ engines: ["parakeet"], models: [{ id: "small", engine: "whisper", downloaded: false }] })
    expect(status).toEqual({
      engines: [{ id: "parakeet" }],
      models: [{ id: "small", engine: "whisper", downloaded: false }],
    })
  })

  it("payload irreconhecível vira null", () => {
    expect(parseVoiceStatus(null)).toBeNull()
    expect(parseVoiceStatus("parakeet")).toBeNull()
    expect(parseVoiceStatus({})).toBeNull()
  })
})

describe("voiceTargetReady", () => {
  const status = parseVoiceStatus({
    engines: [
      { id: "parakeet", available: true, installed: true },
      { engine: "whisper", available: true, installed: false },
    ],
    models: { small: { installed: true, engine: "whisper" }, medium: { installed: false, engine: "whisper" } },
  })

  it("sem status não bloqueia (quem falha é o start)", () => {
    expect(voiceTargetReady(null, "parakeet", null)).toBe(true)
    expect(voiceTargetReady(parseVoiceStatus({ models: {} }), "whisper", null)).toBe(true)
  })

  it("motor disponível e modelo baixado libera", () => {
    expect(voiceTargetReady(status, "parakeet", null)).toBe(true)
    expect(voiceTargetReady(status, "whisper", "small")).toBe(true)
  })

  it("motor desconhecido ou indisponível bloqueia", () => {
    expect(voiceTargetReady(status, "apple", null)).toBe(false)
    const indisponivel = parseVoiceStatus({ engines: [{ id: "whisper", available: false }], models: {} })
    expect(voiceTargetReady(indisponivel, "whisper", "small")).toBe(false)
  })

  it("motor sem nenhum modelo no disco bloqueia (modelId nulo = o recomendado)", () => {
    expect(voiceTargetReady(status, "whisper", null)).toBe(false)
  })

  it("modelo escolhido que o main não viu baixado bloqueia", () => {
    expect(voiceTargetReady(status, "whisper", "medium")).toBe(false)
    expect(voiceTargetReady(status, "whisper", "large-v3-turbo")).toBe(false)
  })
})

describe("appendDictation", () => {
  it("junta com um espaço quando falta separador", () => {
    expect(appendDictation("manda uma mensagem", "pro João")).toBe("manda uma mensagem pro João")
  })

  it("respeita o espaço ou a quebra que o usuário já digitou", () => {
    expect(appendDictation("manda uma mensagem ", "pro João")).toBe("manda uma mensagem pro João")
    expect(appendDictation("linha um\n", "linha dois")).toBe("linha um\nlinha dois")
  })

  it("input vazio recebe só o ditado, sem espaço na frente", () => {
    expect(appendDictation("", "  bom dia  ")).toBe("bom dia")
  })

  it("ditado vazio não mexe no que o usuário escreveu", () => {
    expect(appendDictation("texto do usuário", "")).toBe("texto do usuário")
    expect(appendDictation("texto do usuário", "   \n ")).toBe("texto do usuário")
  })
})

describe("pcm16ToBase64", () => {
  it("codifica o PCM16 em little-endian", () => {
    expect(pcm16ToBase64(new Int16Array([1, -1]))).toBe("AQD//w==")
    expect(pcm16ToBase64(new Int16Array([0, 0, 0, 0]))).toBe("AAAAAAAAAAA=")
  })

  it("aguenta mais de um bloco interno sem estourar a pilha", () => {
    const pcm = new Int16Array(20000).fill(1000)
    // 40 000 bytes: 4 caracteres por grupo de 3 bytes, com padding no fim
    expect(pcm16ToBase64(pcm).length).toBe(4 * Math.ceil(pcm.byteLength / 3))
    expect(Buffer.from(pcm16ToBase64(pcm), "base64").byteLength).toBe(pcm.byteLength)
  })

  it("respeita o offset da view", () => {
    const buffer = new Int16Array([9, 1, -1]).subarray(1)
    expect(pcm16ToBase64(buffer)).toBe("AQD//w==")
  })
})

describe("pcmWorkletUrl", () => {
  it("resolve na raiz do documento (dev e file:// do build)", () => {
    expect(pcmWorkletUrl("http://localhost:5173/")).toBe("http://localhost:5173/pcm-capture-worklet.js")
    expect(pcmWorkletUrl("file:///opt/orbit/dist/index.html")).toBe("file:///opt/orbit/dist/pcm-capture-worklet.js")
  })
})
