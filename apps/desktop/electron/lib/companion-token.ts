/**
 * Tokens assinados para os arquivos que o app mobile baixa por HTTP.
 *
 * O celular não tem os schemes do Electron (`orbit-media://`, `orbit-audio://`,
 * `orbit-video://`, `orbit-artifact://`, `orbit-motion://`…), então tudo o que
 * ele precisa ver vira uma URL do servidor do companion. E como `<Image>`,
 * `<video>` e o WebView não mandam o header `Authorization` de forma confiável,
 * a autorização vai no CAMINHO da URL — não na query: uma peça de motion
 * referencia `base.css`, `clip.mp4` e afins por caminho relativo, e um token na
 * query não acompanharia esses pedidos (o relativo resolve contra o caminho, e
 * sim contra a query do documento). Com o token como um SEGMENTO do caminho,
 * `/api/file/motion/mv_x/<token>/base.css` funciona sem reescrever nada dentro
 * da peça.
 *
 * Módulo separado do servidor para o segredo e a assinatura terem um dono só:
 * quem assina (companion-server, ao reescrever as parts) e quem valida (o
 * servidor HTTP) precisam concordar exatamente.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 24h: longo o bastante para o cache do app sobreviver a scroll, re-render e
 * reabrir a conversa sem refetch de token; curto o bastante para uma URL
 * vazada não valer para sempre.
 */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Segredo persistido em orbit-data/media-secret — tokens assinados sobrevivem
 * a restarts do desktop (senão toda imagem já entregue ao mobile viraria 401
 * ao reiniciar o app). Leitura síncrona: precisa estar pronto antes do 1º token.
 */
function loadSecret(): string {
  const file = path.join(app.getPath('userData'), 'orbit-data', 'media-secret')
  try {
    const existing = fsSync.readFileSync(file, 'utf8').trim()
    if (existing.length === 64) return existing
  } catch {
    /* ainda não existe — gera abaixo */
  }
  const secret = randomBytes(32).toString('hex')
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    fsSync.writeFileSync(file, secret, { mode: 0o600 })
  } catch {
    console.warn('[CompanionToken] Não foi possível persistir o segredo — tokens não sobrevivem a restart')
  }
  return secret
}

const secret = loadSecret()

/**
 * Cada escopo tem a sua raiz e o seu resolvedor no desktop (ver
 * companion-assets.ts). O token vale para o par escopo+id: um token de
 * `video/vid_x` não abre `artifact/art_y.html`.
 */
export type AssetScope =
  | 'media'
  | 'artifact'
  | 'audio'
  | 'video'
  | 'motion'
  | 'design'
  | 'slides'
  /** Um arquivo da biblioteca de fontes (`<hash>.woff2`): o `orbit-font://` não
   *  existe no celular, e é ele que o `<style>` do `font_use` referencia. */
  | 'font'

const SCOPES: readonly AssetScope[] = [
  'media',
  'artifact',
  'audio',
  'video',
  'motion',
  'design',
  'slides',
  'font',
]

export function isAssetScope(value: string): value is AssetScope {
  return (SCOPES as readonly string[]).includes(value)
}

/**
 * `media` mantém a assinatura histórica (só o id, sem escopo).
 *
 * Não é preguiça: esse formato já foi entregue a apps conectados e o segredo
 * sobrevive a restart, então mudá-lo invalidaria toda imagem já em tela até a
 * próxima sincronização de mensagens — um bug que só apareceria no celular de
 * quem já estava conectado. Os escopos novos nascem com o formato correto.
 */
function signPayload(scope: AssetScope, id: string, exp: number): string {
  const payload = scope === 'media' ? `${id}:${exp}` : `${scope}:${id}:${exp}`
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function createAssetToken(scope: AssetScope, id: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  return `${exp}.${signPayload(scope, id, exp)}`
}

export function validateAssetToken(
  scope: AssetScope,
  id: string,
  token: string | null,
): boolean {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const exp = Number(token.slice(0, dot))
  const sig = token.slice(dot + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expected = signPayload(scope, id, exp)
  if (expected.length !== sig.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
}
