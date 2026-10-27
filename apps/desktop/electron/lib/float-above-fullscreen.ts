import { app, type BrowserWindow } from 'electron'

/**
 * Deixa a janela visível em todos os espaços, inclusive sobre apps em tela
 * cheia (overlay, faixa e painéis do Computer Use).
 *
 * No macOS, `visibleOnFullScreen` transforma o processo em app "UIElement":
 * o ícone some do Dock e o Orbit passa a abrir em segundo plano, só voltando
 * com um segundo clique. O Orbit é um app de Dock de verdade, então o ícone é
 * devolvido logo depois da transformação.
 */
export function floatAboveFullScreen(win: BrowserWindow): void {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') void app.dock?.show()
}
