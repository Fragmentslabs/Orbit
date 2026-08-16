import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Rotina, RotinaRun } from '@shared/rotinas'

/**
 * Persistência das rotinas: JSON na pasta de dados do app, espelhando o modo
 * esteira (electron/lib/esteira/repo.ts).
 *
 *   orbit-data/rotinas/rotinas.json
 *   orbit-data/rotinas/runs.json
 *
 * Escrita atômica (tmp + rename) e serial por arquivo: o scheduler grava o
 * resultado de uma execução enquanto a UI pode estar salvando a edição de
 * outra rotina, e duas escritas concorrentes perderiam uma das versões.
 */

function baseDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'rotinas')
}

/** Fila serial por arquivo — mesma ideia do repo da esteira. */
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
    return (JSON.parse(raw) as T) ?? vazio
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

const ROTINAS = 'rotinas.json'
const RUNS = 'runs.json'

// ─── Rotinas ─────────────────────────────────────────────────────────────────

/** Migração: rotinas criadas antes do campo `mode` explícito são de código. */
function migrarRotina(rotina: Rotina): Rotina {
  return { ...rotina, mode: rotina.mode ?? 'code' }
}

/**
 * Leitura de rotinas SEMPRE com a migração aplicada — inclusive nos caminhos
 * de escrita: um `atualizarRotina` lendo o JSON cru emitiria no evento uma
 * rotina sem `mode`, e o renderer a filtra para fora da listagem do modo
 * (`r.mode === modo`) — a rotina "some" ao ser desativada. Aplicar a migração
 * aqui também autocura o arquivo na próxima escrita.
 */
async function lerRotinas(): Promise<Rotina[]> {
  return (await ler<Rotina[]>(ROTINAS, [])).map(migrarRotina)
}

export function listarRotinas(): Promise<Rotina[]> {
  return lerRotinas()
}

export function salvarRotinas(rotinas: Rotina[]): Promise<void> {
  return comLock(ROTINAS, () => escrever(ROTINAS, rotinas))
}

/**
 * Atualiza UMA rotina dentro do lock. Ler-modificar-gravar fora dele perderia
 * atualizações quando o scheduler grava `ultimaExecucao` enquanto a UI salva a
 * edição de outra rotina.
 */
export function atualizarRotina(
  id: string,
  patch: (rotina: Rotina) => Rotina,
): Promise<Rotina | null> {
  return comLock(ROTINAS, async () => {
    const rotinas = await lerRotinas()
    const indice = rotinas.findIndex((r) => r.id === id)
    if (indice < 0) return null
    const atualizada = patch(rotinas[indice])
    rotinas[indice] = atualizada
    await escrever(ROTINAS, rotinas)
    return atualizada
  })
}

export function adicionarRotina(rotina: Rotina): Promise<Rotina> {
  return comLock(ROTINAS, async () => {
    const rotinas = await ler<Rotina[]>(ROTINAS, [])
    await escrever(ROTINAS, [...rotinas, rotina])
    return rotina
  })
}

export function removerRotina(id: string): Promise<void> {
  return comLock(ROTINAS, async () => {
    const rotinas = await ler<Rotina[]>(ROTINAS, [])
    await escrever(
      ROTINAS,
      rotinas.filter((r) => r.id !== id),
    )
  })
}

// ─── Execuções ───────────────────────────────────────────────────────────────

export function listarRuns(): Promise<RotinaRun[]> {
  return ler<RotinaRun[]>(RUNS, [])
}

/** Insere ou substitui o registro da execução (chave: sessionId). */
export function salvarRun(run: RotinaRun): Promise<RotinaRun> {
  return comLock(RUNS, async () => {
    const runs = await ler<RotinaRun[]>(RUNS, [])
    const indice = runs.findIndex((r) => r.sessionId === run.sessionId)
    if (indice >= 0) runs[indice] = run
    else runs.push(run)
    await escrever(RUNS, runs)
    return run
  })
}

export function removerRunsDaRotina(rotinaId: string): Promise<void> {
  return comLock(RUNS, async () => {
    const runs = await ler<RotinaRun[]>(RUNS, [])
    await escrever(
      RUNS,
      runs.filter((r) => r.rotinaId !== rotinaId),
    )
  })
}

/**
 * Poda métricas órfãs: o chat de um run foi excluído pela sidebar, então o
 * registro não tem mais nada a que se referir (a lista do painel é derivada
 * das sessões). Melhor apagar de vez do que manter um run "excluído".
 */
export function podarRuns(sessionIdsVivos: string[]): Promise<number> {
  return comLock(RUNS, async () => {
    const runs = await ler<RotinaRun[]>(RUNS, [])
    const vivos = new Set(sessionIdsVivos)
    // Um run RODANDO ainda não tem sessão no store do renderer em todos os
    // momentos (a criação e o primeiro evento correm juntos) — não podar.
    const restantes = runs.filter((r) => vivos.has(r.sessionId) || r.status === 'rodando')
    if (restantes.length === runs.length) return 0
    await escrever(RUNS, restantes)
    return runs.length - restantes.length
  })
}
