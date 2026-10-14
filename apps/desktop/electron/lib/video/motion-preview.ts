import fsp from 'node:fs/promises'
import path from 'node:path'
import { registerMotion } from './motion-store'

/**
 * Preparo do preview de uma composição de motion — o degrau entre ESCREVER a
 * composição e renderizá-la: o agente escreve o HTML, esta aqui registra e
 * avisa a aba Motion do painel (o usuário confere com play/pause e slider) e só
 * depois de aprovada a composição vai para `motion_render`. Nada é renderizado
 * nem escrito na pasta de trabalho aqui.
 *
 * O alvo que o agente passa (o `.html` de entrada, ou a pasta dele) vira (pasta
 * servida, arquivo de entrada) e a composição entra no registro
 * (video/motion-store), de onde a aba Motion a carrega pelo scheme
 * `orbit-motion://`.
 *
 * Vive fora da tool para que a derivação seja PURA: dá para testá-la sem
 * Electron, como o resto do video/.
 */

/** Entrada assumida quando o alvo é uma PASTA. */
export const MOTION_ENTRY_FILE = 'index.html'

export interface MotionTarget {
  /** Pasta raiz: o scheme não serve nada fora dela (dependências ficam ao lado). */
  folder: string
  /** Arquivo de entrada (absoluto), sempre dentro de `folder`. */
  file: string
  /**
   * Caminho da entrada DENTRO da pasta, com `/` — é o que a aba junta em
   * `orbit-motion://<id>/<entry>`. Como a pasta é sempre a que contém o
   * arquivo, isto é o nome do arquivo (`index.html`, quase sempre).
   */
  entry: string
}

/**
 * (pasta, entrada) a partir do alvo já em caminho absoluto. Puro: `isDir` diz
 * se o alvo é uma pasta — pasta usa o `index.html` dela, arquivo é a própria
 * entrada (e a pasta servida é a que o contém).
 */
export function motionTargetFrom(abs: string, isDir: boolean): MotionTarget {
  const resolved = path.resolve(abs)
  const file = isDir ? path.join(resolved, MOTION_ENTRY_FILE) : resolved
  return { folder: path.dirname(file), file, entry: path.basename(file) }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

export interface MotionPreview extends MotionTarget {
  /** Id do registro — a aba o usa para assinar a recarga ao vivo. */
  id: string
  /** URL do scheme que a aba carrega: `orbit-motion://<id>/<entry>`. */
  url: string
}

/**
 * Resolve a pasta/entrada do alvo, confere que a entrada EXISTE (a aba abriria
 * num 404 silencioso, e o erro cedo vale mais) e registra a composição. Só o
 * registro toca o disco; a derivação acima é pura.
 */
export async function prepareMotionPreview(
  target: string,
  opts: { root?: string; sessionId?: string } = {},
): Promise<MotionPreview> {
  const abs = path.resolve(target)
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(abs)
  } catch {
    throw new Error(`motion composition not found: ${abs}`)
  }
  const { folder, file, entry } = motionTargetFrom(abs, stat.isDirectory())
  if (stat.isDirectory() && !(await isFile(file))) {
    throw new Error(`the composition folder has no ${MOTION_ENTRY_FILE}: ${abs}`)
  }
  const { id, url } = await registerMotion(folder, file, opts)
  return { folder, file, entry, id, url }
}
