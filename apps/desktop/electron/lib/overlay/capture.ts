import { desktopCapturer, screen } from 'electron'
import sharp from 'sharp'
import { getOverlayWindow } from './window'

/**
 * Captures the screen for the overlay's `see_screen` tool.
 *
 * The panel cannot show up in the print — it is always in front, at the bottom, and
 * the model would describe its own interface — but it cannot blink out of the screen
 * either. The overlay window is born with `setContentProtection(true)`: the system
 * draws it for the person and excludes it from any capture, so the print comes out
 * clean with the panel sitting where it is. Only on Linux, where the protection is a
 * no-op, the panel is still hidden during the frame and given back afterwards.
 *
 * It also captures the monitor where the cursor is, not "the main screen" — whoever
 * uses two monitors is asking about what they are looking at.
 */

export interface OverlayShot {
  data: Buffer
  mediaType: 'image/jpeg'
  width: number
  height: number
  /** Name of the captured monitor (for the return text). */
  display: string
}

/**
 * Ceiling in bytes of the image sent to the model — the same as Computer Use's. A
 * full-screen PNG easily goes over 1 MB and was refused ("the print came out too
 * big"); as JPEG, 1200 px stays in the hundreds of KB.
 */
export const MAX_MODEL_IMAGE_BYTES = 280_000
const MAX_EDGE = 1200
const MIN_EDGE = 640
const QUALITY = 82
/** Time for the compositor to take the window out of the frame before the print (Linux only). */
const HIDE_SETTLE_MS = 120

/** macOS and Windows exclude the protected window from the capture; on Linux it is a no-op. */
const CONTENT_PROTECTION_WORKS = process.platform === 'darwin' || process.platform === 'win32'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function encode(raw: Buffer, edge: number) {
  const { data, info } = await sharp(raw)
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY, chromaSubsampling: '4:2:0' })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

export async function captureScreenForOverlay(maxEdge = MAX_EDGE): Promise<OverlayShot | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  // With content protection nothing moves: the panel stays on screen
  // (and with the focus, if it had it) while the print is taken. The old
  // hide-and-show path remains only as a fallback on Linux.
  const win = CONTENT_PROTECTION_WORKS ? null : getOverlayWindow()
  const wasVisible = !!win && win.isVisible()
  const wasFocused = !!win && win.isFocused()

  if (win && wasVisible) {
    win.hide()
    await sleep(HIDE_SETTLE_MS)
  }

  try {
    const scale = display.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, Math.round(display.size.width * scale)),
        height: Math.max(1, Math.round(display.size.height * scale)),
      },
      fetchWindowIcons: false,
    })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) ?? sources[0]
    if (!source) return null
    const raw = source.thumbnail
    if (raw.isEmpty()) return null

    // Byte budget: it lowers the edge until it fits, instead of omitting the image
    // (a full-screen print would never fit the ceiling as PNG). The source PNG
    // is generated ONCE: re-encoding on every attempt would cost hundreds of ms.
    const png = raw.toPNG()
    let edge = Math.min(maxEdge, MAX_EDGE)
    let sized = await encode(png, edge)
    while (sized.data.length > MAX_MODEL_IMAGE_BYTES && edge > MIN_EDGE) {
      edge = Math.max(MIN_EDGE, Math.round(edge * 0.8))
      sized = await encode(png, edge)
    }

    return {
      data: sized.data,
      mediaType: 'image/jpeg',
      width: sized.width,
      height: sized.height,
      display: display.label || `${display.size.width}×${display.size.height}`,
    }
  } finally {
    if (win && wasVisible && !win.isDestroyed()) {
      if (wasFocused) {
        win.show()
        win.focus()
      } else {
        win.showInactive()
      }
    }
  }
}
