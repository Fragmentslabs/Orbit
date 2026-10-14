import type { NativeImage, WebContents } from 'electron'

/**
 * `capturePage` de uma janela offscreen FALHA às vezes com `UnknownVizError`:
 * o mesmo quadro, na mesma janela, captura, falha e captura de novo em três
 * chamadas seguidas (medido no Electron 44, Windows). Sem tratar, uma olhada do
 * motion_frame quebrava ao acaso — e um render de 500 quadros quebrava quase
 * certo, no meio.
 *
 * Aqui a captura pede um quadro novo (`invalidate`) e tenta de novo, com uma
 * espera curta e crescente. Uma falha que persiste nas tentativas é real e sobe.
 */
export async function capturePageReliably(contents: WebContents, attempts = 5): Promise<NativeImage> {
  let last: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const image = await contents.capturePage()
      if (!image.isEmpty()) return image
      last = new Error('the capture came back empty')
    } catch (err) {
      last = err
    }
    if (contents.isDestroyed()) break
    contents.invalidate()
    await new Promise((resolve) => setTimeout(resolve, 30 * (i + 1)))
  }
  throw last instanceof Error ? last : new Error(String(last))
}
