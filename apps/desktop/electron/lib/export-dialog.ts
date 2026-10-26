import { app, dialog, type BrowserWindow, type FileFilter } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson } from './storage'

/**
 * O "Salvar como…" de toda mídia que sai do Orbit.
 *
 * Antes cada export abria onde calhava: o render da aba caía dentro da pasta
 * interna da composição, o PDF do deck no diretório de trabalho do processo, e
 * os demais dependiam da memória do diálogo do sistema — que no macOS existe e
 * no Windows não. Aqui a regra é uma só: começa na última pasta em que a pessoa
 * salvou alguma coisa e, na primeira vez (ou se aquela pasta sumiu), na pasta de
 * Downloads do sistema.
 *
 * A escolha é lembrada para o app inteiro, e não por tipo de arquivo: quem
 * organiza os vídeos em ~/Desktop/videos quer o PDF do deck no mesmo lugar.
 */

const STORAGE_KEY = 'export-dir'

/** Última pasta escolhida — devolvida só enquanto continuar existindo. */
async function rememberedDir(): Promise<string | null> {
  const stored = await readJson<{ dir?: string }>(STORAGE_KEY).catch(() => null)
  const dir = stored?.dir
  if (!dir) return null
  try {
    return (await fsp.stat(dir)).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** Onde o próximo diálogo abre. */
export async function exportDir(): Promise<string> {
  const remembered = await rememberedDir()
  if (remembered) return remembered
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/**
 * Nome de arquivo seguro: sem separador de caminho, sem nome vazio e sem
 * exagero de comprimento. O nome em si vem do chamador — é o nome da MÍDIA no
 * Orbit, nunca um "render" ou "arquivo" genérico.
 */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'arquivo'
}

/**
 * Abre o diálogo de salvar e devolve o caminho escolhido, ou `null` se a pessoa
 * cancelou (cancelar não é erro em nenhum chamador). A pasta escolhida passa a
 * ser a de partida dos próximos exports.
 */
export async function saveExport(
  window: BrowserWindow | null,
  input: { title?: string; fileName: string; filters?: FileFilter[] },
): Promise<string | null> {
  const options = {
    title: input.title,
    defaultPath: path.join(await exportDir(), safeFileName(input.fileName)),
    filters: input.filters,
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  // Lembrar DEPOIS de salvar: é a pasta em que a pessoa realmente guardou.
  await writeJson(STORAGE_KEY, { dir: path.dirname(result.filePath) }).catch(() => {})
  return result.filePath
}
