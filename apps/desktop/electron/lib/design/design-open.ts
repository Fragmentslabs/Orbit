import path from 'node:path'
import { listMedia } from '../media'
import { panelDesignPreview } from '../panel-browser'
import { readDesignCanvas } from './design-canvas'
import { registerDesignCover } from './design-gallery'
import { getDesign, registerDesign } from './design-store'

/** O canvas já tem item na galeria? O `designId` é o vínculo, não a pasta. */
async function isInGallery(id: string): Promise<boolean> {
  try {
    const items = await listMedia({ kind: 'design' })
    return items.some((item) => item.designId === id)
  } catch {
    return false
  }
}

/**
 * Reabre um canvas que JÁ está no registro — o card do chat, o tile da Mídia.
 * Sem sessionId de propósito: o renderer resolve o balde pelo chat ATIVO (ver
 * reopenMotion, o mesmo raciocínio).
 */
export async function reopenDesign(id: string): Promise<boolean> {
  const entry = await getDesign(id)
  if (!entry) return false
  await registerDesign(entry.folder, {}).catch(() => {})
  panelDesignPreview({ id, title: path.basename(entry.folder), path: entry.folder })
  return true
}

/**
 * Abre um canvas na aba Design e conta ao agente como ele ficou — o passo
 * comum de design_write/design_edit. Registra a pasta, manda o painel abrir (ou
 * focar) a aba, e valida o canvas.json (sem renderizar nada: ao contrário do
 * motion, o artboard é HTML estático — o próprio iframe sandbox valida o resto).
 */
export async function openDesignAndReport(input: {
  /** Pasta do canvas, já resolvida e autorizada. */
  target: string
  root?: string
  sessionId: string
  label: string
  nextStep: string
}): Promise<string> {
  const reg = await registerDesign(input.target, { root: input.root, sessionId: input.sessionId })
  const name = path.basename(input.target)
  panelDesignPreview({ id: reg.id, title: name, path: input.target, sessionId: input.sessionId })
  try {
    const canvas = await readDesignCanvas(input.target)
    if (canvas.order.length === 0) throw new Error('canvas.json has no artboards in "order"')
    if (!(await isInGallery(reg.id))) {
      await registerDesignCover(reg.id, { sessionId: input.sessionId }).catch(() => false)
    }
    const boards = canvas.order.map((file) => {
      const b = canvas.boards[file]
      if (!b) return `"${file}" (missing from boards!)`
      return `"${b.title ?? file}" (${file}, ${Math.round(b.w)}×${Math.round(b.h)} at ${Math.round(b.x)},${Math.round(b.y)})`
    })
    return [
      `Design "${name}" is open in the Design tab of the right panel (${input.label}) with ${boards.length} artboard${boards.length === 1 ? '' : 's'}: ${boards.join('; ')}.`,
      input.nextStep,
    ].join('\n')
  } catch (err) {
    return `Design "${name}" is open in the Design tab, but canvas.json could not be read: ${err instanceof Error ? err.message : String(err)}. Fix it with design_edit or design_write and read this result again.`
  }
}
