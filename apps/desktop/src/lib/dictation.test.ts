import { describe, expect, it } from "vitest"
import type { AppSettings } from "@shared/app-settings"
import {
  appendDictation,
  pcm16ToBase64,
  pcmLevel,
  pcmWorkletUrl,
  parseVoiceStatus,
  resolveVoiceSttSettings,
  voiceTargetReady,
} from "./dictation"

/** AppSettings without the `voice` block (localStorage from an earlier version). */
const withoutVoice = {} as AppSettings

/** AppSettings with the block, the way the raw object would arrive from localStorage. */
const withVoice = (stt: Record<string, unknown>) => ({ voice: { stt } }) as unknown as AppSettings

describe("resolveVoiceSttSettings", () => {
  it("a missing block falls back to the product defaults", () => {
    expect(resolveVoiceSttSettings(withoutVoice)).toEqual({
      enabled: true,
      engine: "parakeet",
      modelId: null,
      language: "auto",
      live: true,
      threads: 4,
      preload: true,
      micDeviceId: null,
    })
  })

  it("reads what the user chose", () => {
    const voice = resolveVoiceSttSettings(
      withVoice({
        enabled: false,
        engine: "whisper",
        modelId: "small",
        language: "en",
        live: false,
        threads: 8,
        preload: false,
        micDeviceId: "usb-mic",
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
      micDeviceId: "usb-mic",
    })
  })

  it("values of the wrong type do not leak into the engine", () => {
    const voice = resolveVoiceSttSettings(
      withVoice({ enabled: "sim", engine: 42, modelId: "", language: null, live: "on", threads: NaN, preload: "sim", micDeviceId: 7 }),
    )
    expect(voice).toEqual({
      enabled: true,
      engine: "parakeet",
      modelId: null,
      language: "auto",
      live: true,
      threads: 4,
      preload: true,
      micDeviceId: null,
    })
  })

  it("null and undefined do not throw", () => {
    expect(resolveVoiceSttSettings(null).engine).toBe("parakeet")
    expect(resolveVoiceSttSettings(undefined).enabled).toBe(true)
  })
})

describe("parseVoiceStatus", () => {
  it("accepts models as a map by id (the channel's shape)", () => {
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

  it("accepts lists of objects and of strings", () => {
    const status = parseVoiceStatus({ engines: ["parakeet"], models: [{ id: "small", engine: "whisper", downloaded: false }] })
    expect(status).toEqual({
      engines: [{ id: "parakeet" }],
      models: [{ id: "small", engine: "whisper", downloaded: false }],
    })
  })

  it("an unrecognizable payload becomes null", () => {
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

  it("with no status it does not block (start is the one that fails)", () => {
    expect(voiceTargetReady(null, "parakeet", null)).toBe(true)
    expect(voiceTargetReady(parseVoiceStatus({ models: {} }), "whisper", null)).toBe(true)
  })

  it("an available engine and a downloaded model free it", () => {
    expect(voiceTargetReady(status, "parakeet", null)).toBe(true)
    expect(voiceTargetReady(status, "whisper", "small")).toBe(true)
  })

  it("an unknown or unavailable engine blocks it", () => {
    expect(voiceTargetReady(status, "apple", null)).toBe(false)
    const unavailable = parseVoiceStatus({ engines: [{ id: "whisper", available: false }], models: {} })
    expect(voiceTargetReady(unavailable, "whisper", "small")).toBe(false)
  })

  it("an engine with no model on disk blocks it (null modelId = the recommended one)", () => {
    expect(voiceTargetReady(status, "whisper", null)).toBe(false)
  })

  it("a chosen model that main did not see downloaded blocks", () => {
    expect(voiceTargetReady(status, "whisper", "medium")).toBe(false)
    expect(voiceTargetReady(status, "whisper", "large-v3-turbo")).toBe(false)
  })
})

describe("appendDictation", () => {
  it("joins with a space when the separator is missing", () => {
    expect(appendDictation("manda uma mensagem", "pro João")).toBe("manda uma mensagem pro João")
  })

  it("respects the space or break the user already typed", () => {
    expect(appendDictation("manda uma mensagem ", "pro João")).toBe("manda uma mensagem pro João")
    expect(appendDictation("linha um\n", "linha dois")).toBe("linha um\nlinha dois")
  })

  it("an empty input receives only the dictation, with no leading space", () => {
    expect(appendDictation("", "  bom dia  ")).toBe("bom dia")
  })

  it("empty dictation does not touch what the user wrote", () => {
    expect(appendDictation("texto do usuário", "")).toBe("texto do usuário")
    expect(appendDictation("texto do usuário", "   \n ")).toBe("texto do usuário")
  })
})

describe("pcm16ToBase64", () => {
  it("encodes PCM16 as little-endian", () => {
    expect(pcm16ToBase64(new Int16Array([1, -1]))).toBe("AQD//w==")
    expect(pcm16ToBase64(new Int16Array([0, 0, 0, 0]))).toBe("AAAAAAAAAAA=")
  })

  it("handles more than one inner block without blowing the stack", () => {
    const pcm = new Int16Array(20000).fill(1000)
    // 40 000 bytes: 4 characters per group of 3 bytes, with padding at the end
    expect(pcm16ToBase64(pcm).length).toBe(4 * Math.ceil(pcm.byteLength / 3))
    expect(Buffer.from(pcm16ToBase64(pcm), "base64").byteLength).toBe(pcm.byteLength)
  })

  it("respects the view's offset", () => {
    const buffer = new Int16Array([9, 1, -1]).subarray(1)
    expect(pcm16ToBase64(buffer)).toBe("AQD//w==")
  })
})

describe("pcmWorkletUrl", () => {
  it("resolves at the document root (dev and the build's file://)", () => {
    expect(pcmWorkletUrl("http://localhost:5173/")).toBe("http://localhost:5173/pcm-capture-worklet.js")
    expect(pcmWorkletUrl("file:///opt/orbit/dist/index.html")).toBe("file:///opt/orbit/dist/pcm-capture-worklet.js")
  })
})

describe("pcmLevel", () => {
  it("silence and an empty block stay at the floor", () => {
    expect(pcmLevel(new Int16Array(0))).toBe(0)
    expect(pcmLevel(new Int16Array(1024))).toBe(0)
  })

  it("rises with the volume and saturates at 1", () => {
    const tone = (amp: number) => Int16Array.from({ length: 1024 }, (_, i) => Math.round(amp * Math.sin(i / 4)))
    const low = pcmLevel(tone(300))
    const mid = pcmLevel(tone(3000))
    expect(low).toBeGreaterThan(0)
    expect(mid).toBeGreaterThan(low)
    expect(pcmLevel(tone(32767))).toBe(1)
  })
})
