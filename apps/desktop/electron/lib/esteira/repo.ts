import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Esteira, FaseTemplate, Projeto, Task } from '@shared/esteira'

/**
 * Persistência do modo esteira: JSON na pasta de dados do app (§15), sem banco
 * novo nesta fase.
 *
 *   orbit-data/esteira/projetos.json
 *   orbit-data/esteira/esteiras.json
 *   orbit-data/esteira/tasks-<esteiraId>.json
 *
 * Escrita atômica (tmp + rename) e serial por arquivo: o engine grava a cada
 * transição de fase enquanto a UI também edita, e duas escritas concorrentes
 * no mesmo arquivo perderiam uma das versões.
 */

const SAFE_ID = /^[a-zA-Z0-9_-]+$/

function baseDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'esteira')
}

/** Fila serial por arquivo — mesma ideia do índice de mídia. */
const filas = new Map<string, Promise<unknown>>()

function comLock<T>(arquivo: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filas.get(arquivo) ?? Promise.resolve()
  const proxima = anterior.then(fn, fn)
  filas.set(
    arquivo,
    proxima.catch(() => {}),
  )
  return proxima
}

async function ler<T>(arquivo: string, vazio: T): Promise<T> {
  try {
    const raw = await fsp.readFile(path.join(baseDir(), arquivo), 'utf8')
    const parsed = JSON.parse(raw) as T
    return parsed ?? vazio
  } catch {
    // ausente ou corrompido — a UI recomeça do estado vazio em vez de quebrar
    return vazio
  }
}

async function escrever(arquivo: string, valor: unknown): Promise<void> {
  const dir = baseDir()
  await fsp.mkdir(dir, { recursive: true })
  const destino = path.join(dir, arquivo)
  const tmp = `${destino}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(valor, null, 2), 'utf8')
  await fsp.rename(tmp, destino)
}

// ─── Projetos ────────────────────────────────────────────────────────────────

export function listarProjetos(): Promise<Projeto[]> {
  return ler<Projeto[]>('projetos.json', [])
}

export function salvarProjetos(projetos: Projeto[]): Promise<void> {
  return comLock('projetos.json', () => escrever('projetos.json', projetos))
}

// ─── Esteiras ────────────────────────────────────────────────────────────────

export function listarEsteiras(): Promise<Esteira[]> {
  return ler<Esteira[]>('esteiras.json', [])
}

export function salvarEsteiras(esteiras: Esteira[]): Promise<void> {
  return comLock('esteiras.json', () => escrever('esteiras.json', esteiras))
}

// ─── Templates de fase editados pelo usuário ─────────────────────────────────

/**
 * Templates que o usuário criou ou sobrescreveu ("salvar como padrão"). Ficam
 * separados dos embutidos: assim uma atualização do Orbit pode melhorar os
 * prompts de fábrica sem apagar o que o usuário escreveu, e o id em comum
 * indica qual embutido está sobrescrito.
 */
export function listarTemplatesCustom(): Promise<FaseTemplate[]> {
  return ler<FaseTemplate[]>('templates.json', [])
}

export function salvarTemplatesCustom(templates: FaseTemplate[]): Promise<void> {
  return comLock('templates.json', () => escrever('templates.json', templates))
}

// ─── Tasks (um arquivo por esteira) ──────────────────────────────────────────

function arquivoTasks(esteiraId: string): string {
  if (!SAFE_ID.test(esteiraId)) throw new Error(`id de esteira inválido: ${esteiraId}`)
  return `tasks-${esteiraId}.json`
}

export function listarTasks(esteiraId: string): Promise<Task[]> {
  return ler<Task[]>(arquivoTasks(esteiraId), [])
}

export function salvarTasks(esteiraId: string, tasks: Task[]): Promise<void> {
  const arquivo = arquivoTasks(esteiraId)
  return comLock(arquivo, () => escrever(arquivo, tasks))
}

export async function removerTasks(esteiraId: string): Promise<void> {
  const arquivo = arquivoTasks(esteiraId)
  await comLock(arquivo, () => fsp.rm(path.join(baseDir(), arquivo), { force: true }))
}

/**
 * Atualiza UMA task dentro do lock do arquivo: ler-modificar-gravar fora dele
 * perderia atualizações quando o engine grava o progresso de uma fase enquanto
 * a UI salva a edição de outra task da mesma esteira.
 */
export function atualizarTask(
  esteiraId: string,
  taskId: string,
  patch: (task: Task) => Task,
): Promise<Task | null> {
  const arquivo = arquivoTasks(esteiraId)
  return comLock(arquivo, async () => {
    const tasks = await ler<Task[]>(arquivo, [])
    const indice = tasks.findIndex((t) => t.id === taskId)
    if (indice < 0) return null
    const atualizada = patch(tasks[indice])
    tasks[indice] = atualizada
    await escrever(arquivo, tasks)
    return atualizada
  })
}
