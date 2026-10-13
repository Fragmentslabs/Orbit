import { BrowserWindow } from 'electron'
import { STT_SAMPLE_RATE } from './audio'

/**
 * Arquivo de áudio qualquer → PCM16 mono a 16 kHz, o que os motores de ditado
 * consomem.
 *
 * Quem decodifica é o próprio Chromium do Electron (`decodeAudioData`), numa
 * janela oculta: mp3, m4a/aac, ogg/opus (áudio de WhatsApp), webm, flac e wav,
 * em qualquer sistema, sem dependência nova. O `afconvert` só existe no macOS e
 * não lê opus; o ffmpeg custaria dezenas de MB no app. A reamostragem e a
 * mistura para mono saem de um OfflineAudioContext a 16 kHz.
 *
 * Os bytes entram e saem da janela em PEDAÇOS de base64: um arquivo de 30 MB
 * inteiro dentro de um único `executeJavaScript` viraria um script gigante.
 */

/** Tamanho de cada pedaço (base64) que atravessa a fronteira da janela. */
const CHUNK = 4 * 1024 * 1024
/** Teto do arquivo de entrada e da duração: acima disso a resposta diz o porquê. */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024
export const MAX_AUDIO_MS = 3 * 60 * 60 * 1000
/** A janela fica de pé um pouco para transcrições em sequência; depois some. */
const IDLE_CLOSE_MS = 60_000

let win: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<unknown> = Promise.resolve()

async function decoderWindow(): Promise<BrowserWindow> {
  if (idleTimer) clearTimeout(idleTimer)
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  await win.loadURL('about:blank')
  return win
}

function scheduleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }, IDLE_CLOSE_MS)
  idleTimer.unref?.()
}

/** Roda dentro da janela: decodifica o que foi acumulado em `__orbitIn`. */
const DECODE_IN_PAGE = `(async (rate) => {
  const parts = window.__orbitIn || []
  window.__orbitIn = []
  let total = 0
  const decoded = parts.map((b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    total += bytes.length
    return bytes
  })
  const all = new Uint8Array(total)
  let at = 0
  for (const bytes of decoded) { all.set(bytes, at); at += bytes.length }
  const probe = new OfflineAudioContext(1, 1, rate)
  const audio = await probe.decodeAudioData(all.buffer)
  const frames = Math.max(1, Math.ceil(audio.duration * rate))
  const ctx = new OfflineAudioContext(1, frames, rate)
  const src = ctx.createBufferSource()
  src.buffer = audio
  src.connect(ctx.destination)
  src.start()
  const rendered = (await ctx.startRendering()).getChannelData(0)
  const pcm = new Int16Array(rendered.length)
  for (let i = 0; i < rendered.length; i++) {
    const v = Math.max(-1, Math.min(1, rendered[i]))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  window.__orbitOut = new Uint8Array(pcm.buffer)
  return { bytes: window.__orbitOut.length, durationMs: audio.duration * 1000 }
})`

/** Fatia [start, end) do PCM decodificado, em base64. */
const TAKE_IN_PAGE = `((start, end) => {
  const slice = window.__orbitOut.subarray(start, end)
  let bin = ''
  for (let i = 0; i < slice.length; i += 0x8000) bin += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000))
  return btoa(bin)
})`

/**
 * Decodifica um arquivo de áudio para PCM16 mono 16 kHz. Uma decodificação por
 * vez (a janela é uma só). Lança com mensagem legível para formato inválido.
 */
export function decodeAudioFile(bytes: Buffer): Promise<{ pcm: Buffer; durationMs: number }> {
  const run = async () => {
    if (bytes.length === 0) throw new Error('the audio file is empty')
    if (bytes.length > MAX_AUDIO_BYTES) {
      throw new Error(`the audio is ${(bytes.length / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_AUDIO_BYTES / 1024 / 1024} MB`)
    }
    const page = await decoderWindow()
    try {
      const b64 = bytes.toString('base64')
      await page.webContents.executeJavaScript('window.__orbitIn = []')
      for (let i = 0; i < b64.length; i += CHUNK) {
        await page.webContents.executeJavaScript(`window.__orbitIn.push(${JSON.stringify(b64.slice(i, i + CHUNK))})`)
      }
      let info: { bytes: number; durationMs: number }
      try {
        info = await page.webContents.executeJavaScript(`${DECODE_IN_PAGE}(${STT_SAMPLE_RATE})`)
      } catch {
        throw new Error('could not decode the audio (unsupported format or corrupted file)')
      }
      if (info.durationMs > MAX_AUDIO_MS) {
        throw new Error(`the audio is ${Math.round(info.durationMs / 60000)} min long; the limit is ${MAX_AUDIO_MS / 60000} min`)
      }
      const out: Buffer[] = []
      // Pedaços múltiplos de 2 bytes: nenhuma amostra PCM16 é partida ao meio.
      const step = (CHUNK / 4) * 3 - (((CHUNK / 4) * 3) % 2)
      for (let start = 0; start < info.bytes; start += step) {
        const part: string = await page.webContents.executeJavaScript(
          `${TAKE_IN_PAGE}(${start}, ${Math.min(start + step, info.bytes)})`,
        )
        out.push(Buffer.from(part, 'base64'))
      }
      await page.webContents.executeJavaScript('window.__orbitOut = null')
      return { pcm: Buffer.concat(out), durationMs: info.durationMs }
    } finally {
      scheduleClose()
    }
  }
  const done = queue.then(run, run)
  queue = done.catch(() => {})
  return done
}
