import { BrowserWindow } from 'electron'
import { STT_SAMPLE_RATE } from './audio'

/**
 * Any audio file → PCM16 mono at 16 kHz, what the dictation engines
 * consume.
 *
 * The decoder is Electron's own Chromium (`decodeAudioData`), in a hidden
 * window: mp3, m4a/aac, ogg/opus (WhatsApp audio), webm, flac and wav,
 * on any system, with no new dependency. `afconvert` only exists on macOS and
 * cannot read opus; ffmpeg would cost tens of MB in the app. The resampling and the
 * mixdown to mono come from a 16 kHz OfflineAudioContext.
 *
 * The bytes enter and leave the window in base64 CHUNKS: a whole 30 MB file
 * inside a single `executeJavaScript` would become a gigantic script.
 */

/** Size of each chunk (base64) that crosses the window boundary. */
const CHUNK = 4 * 1024 * 1024
/** Ceiling of the input file and of the duration: above that the answer says why. */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024
export const MAX_AUDIO_MS = 3 * 60 * 60 * 1000
/** The window stays up a while for back-to-back transcriptions; then it goes away. */
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

/** Runs inside the window: decodes what was accumulated in `__orbitIn`. */
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

/** Slices [start, end) of the decoded PCM, in base64. */
const TAKE_IN_PAGE = `((start, end) => {
  const slice = window.__orbitOut.subarray(start, end)
  let bin = ''
  for (let i = 0; i < slice.length; i += 0x8000) bin += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000))
  return btoa(bin)
})`

/**
 * Decodes an audio file to PCM16 mono at 16 kHz. One decoding at a
 * time (there is only one window). It throws with a readable message for an invalid format.
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
      // Chunks that are multiples of 2 bytes: no PCM16 sample is split in half.
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
