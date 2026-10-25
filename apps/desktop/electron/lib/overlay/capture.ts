import { desktopCapturer, screen } from 'electron'
import sharp from 'sharp'
import { getOverlayWindow } from './window'

/**
 * Captura a tela para a tool `see_screen` do overlay.
 *
 * O painel não pode sair no print — ele está sempre na frente, no rodapé, e o
 * modelo descreveria a própria interface — mas também não pode piscar fora da
 * tela. A janela do overlay nasce com `setContentProtection(true)`: o sistema a
 * desenha para a pessoa e a exclui de qualquer captura, então o print sai limpo
 * com o painel parado no lugar. Só no Linux, onde a proteção é no-op, o painel
 * ainda é escondido durante o quadro e devolvido depois.
 *
 * Também captura o monitor onde está o cursor, não "a tela principal" — quem usa
 * dois monitores pergunta sobre o que está vendo.
 */

export interface OverlayShot {
  data: Buffer
  mediaType: 'image/jpeg'
  width: number
  height: number
  /** Nome do monitor capturado (para o texto de retorno). */
  display: string
}

/**
 * Teto de bytes da imagem que vai ao modelo — o mesmo do Computer Use. Um PNG
 * de tela cheia passa fácil de 1 MB e era recusado ("o print ficou muito
 * grande"); em JPEG, 1200 px fica na casa das centenas de KB.
 */
export const MAX_MODEL_IMAGE_BYTES = 280_000
const MAX_EDGE = 1200
const MIN_EDGE = 640
const QUALITY = 82
/** Tempo para o compositor tirar a janela do quadro antes do print (só Linux). */
const HIDE_SETTLE_MS = 120

/** macOS e Windows excluem a janela protegida da captura; no Linux é no-op. */
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
  // Com a proteção de conteúdo nada sai do lugar: o painel continua na tela
  // (e com o foco, se tinha) enquanto o print é tirado. O caminho antigo de
  // esconder-e-mostrar fica só como rede no Linux.
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

    // Orçamento de bytes: desce a aresta até caber, em vez de omitir a imagem
    // (um print de tela cheia nunca caberia no teto como PNG). O PNG de origem
    // é gerado UMA vez: recodificar a cada tentativa custaria centenas de ms.
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
