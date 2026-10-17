import { describe, expect, it } from "vitest"
import {
  MOTION_AUDIO_MAX_NUDGE,
  MOTION_AUDIO_NUDGE_S,
  MOTION_AUDIO_SETTLE_S,
  motionAudioRate,
  motionTrackEnd,
  motionTrackIsLive,
} from "./motion-audio-range"

/** Uma narração da peça de apresentação: 4,319 s de fala a partir de 18,37 s. */
const narracao = { start: 18.37, end: null }

describe("motionTrackEnd", () => {
  it("o `end` declarado manda, mesmo com o arquivo medido", () => {
    expect(motionTrackEnd({ start: 2, end: 4.5 }, 9)).toBe(4.5)
  })

  it("sem `end`, quem fecha a janela é o comprimento real do arquivo", () => {
    expect(motionTrackEnd(narracao, 4.319)).toBeCloseTo(22.689, 3)
  })

  it("sem `end` nem medição, não há janela — quem chama decide", () => {
    expect(motionTrackEnd(narracao, null)).toBeNull()
    expect(motionTrackEnd(narracao, undefined)).toBeNull()
    expect(motionTrackEnd(narracao, 0)).toBeNull()
    expect(motionTrackEnd(narracao, Number.NaN)).toBeNull()
    expect(motionTrackEnd(narracao, Number.POSITIVE_INFINITY)).toBeNull()
    expect(motionTrackEnd(narracao, -3)).toBeNull()
  })
})

describe("motionTrackIsLive", () => {
  it("acende do start até o fim real do arquivo", () => {
    expect(motionTrackIsLive(narracao, 4.319, 18)).toBe(false)
    expect(motionTrackIsLive(narracao, 4.319, 18.37)).toBe(true)
    expect(motionTrackIsLive(narracao, 4.319, 20)).toBe(true)
    expect(motionTrackIsLive(narracao, 4.319, 22.7)).toBe(false)
  })

  it("não fica acesa até o fim da peça só porque o manifest se calou", () => {
    // O defeito que isto corrige: a faixa sendo desenhada e comandada como se
    // tocasse dos 18,37 s até os 38 s da peça.
    expect(motionTrackIsLive(narracao, 4.319, 30)).toBe(false)
    // Sem medição (metadata ainda não chegou) vale o palpite antigo.
    expect(motionTrackIsLive(narracao, null, 30)).toBe(true)
    expect(motionTrackIsLive(narracao, Number.NaN, 30)).toBe(true)
  })

  it("com `end` declarado, a janela é a do manifest e não a do arquivo", () => {
    const cama = { start: 0, end: 12 }
    expect(motionTrackIsLive(cama, 300, 11.9)).toBe(true)
    expect(motionTrackIsLive(cama, 300, 12)).toBe(false)
  })

  it("começa exatamente no start", () => {
    expect(motionTrackIsLive({ start: 5, end: null }, 2, 4.999)).toBe(false)
    expect(motionTrackIsLive({ start: 5, end: null }, 2, 5)).toBe(true)
  })
})

describe("reata do áudio pelo ritmo", () => {
  it("já no lugar, toca no ritmo natural", () => {
    expect(motionAudioRate(0, false)).toBe(1)
    // Dentro da folga não há resample nenhum.
    expect(motionAudioRate(0.05, false)).toBe(1)
    expect(motionAudioRate(-0.05, false)).toBe(1)
  })

  it("a folga é maior que o passo do próprio laço", () => {
    // `at` anda de quadro em quadro (1/30 s ≈ 33 ms), então a deriva medida serra
    // ±33 ms mesmo com o som no lugar certo. Uma folga menor que isso ficaria
    // dentro da serra: o ritmo piscaria a cada quadro, e reiniciar o resample a
    // cada piscada é o estalo que se ouvia.
    const passo = 1 / 30
    expect(MOTION_AUDIO_NUDGE_S).toBeGreaterThan(passo)
    expect(MOTION_AUDIO_SETTLE_S).toBeGreaterThan(passo)
  })

  it("adiantado desacelera, atrasado acelera", () => {
    expect(motionAudioRate(0.2, false)).toBeLessThan(1)
    expect(motionAudioRate(-0.2, false)).toBeGreaterThan(1)
  })

  it("histerese: sai por um limiar menor do que entrou", () => {
    // 0,1 s fica entre os dois limiares: quem já está corrigindo continua...
    expect(motionAudioRate(0.1, true)).toBeLessThan(1)
    // ...e quem está parado não começa por tão pouco.
    expect(motionAudioRate(0.1, false)).toBe(1)
    // Perto o bastante, para dos dois jeitos.
    expect(motionAudioRate(0.02, true)).toBe(1)
  })

  it("nunca passa do teto — a correção tem de ser inaudível", () => {
    for (const drift of [0.2, 0.5, 3, 60, -0.2, -0.5, -3, -60]) {
      for (const engaged of [true, false]) {
        expect(Math.abs(motionAudioRate(drift, engaged) - 1)).toBeLessThanOrEqual(MOTION_AUDIO_MAX_NUDGE + 1e-9)
      }
    }
  })

  it("drift sem sentido não mexe no ritmo", () => {
    expect(motionAudioRate(Number.NaN, false)).toBe(1)
    expect(motionAudioRate(Number.POSITIVE_INFINITY, false)).toBe(1)
  })
})
