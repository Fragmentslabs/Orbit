/**
 * Captura do ditado: entrega o áudio do microfone como PCM 16 bits, 16 kHz,
 * mono, para a thread principal — em blocos de 1024 quadros (~64 ms).
 *
 * O worklet só converte e repassa; quem agrupa os blocos em pedaços de ~128 ms
 * e fala com o motor é o hook `use-dictation`, que é quem sabe quando a fala
 * começou e terminou. Ao soltar o botão o hook pede `flush` pelo port para o
 * resto do bloco sair na hora (sem isso a última sílaba podia ficar no buffer).
 *
 * Roda no AudioWorklet, não no DOM: `AudioWorkletProcessor` e
 * `registerProcessor` são globais de lá; `sampleRate` (do escopo do worklet)
 * não está na lista do ESLint e é declarado abaixo.
 */
/* global sampleRate */

const BLOCK_FRAMES = 1024

class OrbitPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(BLOCK_FRAMES)
    this.filled = 0
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush()
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    // Ainda sem faixa ligada: segue vivo até o áudio chegar.
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === BLOCK_FRAMES) this.flush()
    }
    // true = continua processando: a captura só acaba quando a faixa é solta e
    // o AudioContext fecha — o hook faz as duas coisas sempre.
    return true
  }

  flush() {
    if (this.filled === 0) return
    const frames = this.filled
    const pcm = new Int16Array(frames)
    for (let i = 0; i < frames; i++) {
      const sample = Math.max(-1, Math.min(1, this.buffer[i]))
      // -32768..32767: o lado positivo satura em 0x7fff, o negativo aproveita o
      // valor extra do complemento de dois (o mesmo mapeamento do WAV PCM16).
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    this.filled = 0
    // O buffer vai transferido: sem cópia por bloco, sem lixo acumulado.
    this.port.postMessage({ pcm, sampleRate }, [pcm.buffer])
  }
}

registerProcessor("orbit-pcm-capture", OrbitPcmCapture)
