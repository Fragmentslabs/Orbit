import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MediaEntry } from '@shared/media'
import { writeFileAtomic } from '../asset-lock'

/**
 * Diário de mídia por TURNO — o que torna desfazível tudo o que o agente
 * produziu fora do repositório: peças (motion, design, slides), artefatos,
 * documentos, imagens, áudios e vídeos da galeria.
 *
 * O snapshot do modo código (snapshot/index.ts) fotografa a pasta de trabalho
 * inteira no começo do turno. Aqui isso seria caro (a galeria tem vídeos) e não
 * existiria no chat. Então o registro é PREGUIÇOSO: na primeira vez que um
 * turno vai mexer num caminho ou numa entrada da galeria, guarda-se como ela
 * estava ANTES — uma cópia (clone no APFS, quase de graça) ou "não existia".
 * O que o turno não toca não custa nada.
 *
 * O escopo é um AsyncLocalStorage aberto pelo chat-engine em volta do turno:
 * as tools, o streaming que abre a aba ao vivo e o que eles disparam herdam o
 * escopo sem receber nada por parâmetro. O que roda FORA de um turno (a pessoa
 * editando no painel, excluindo na galeria) não é registrado — não é do agente.
 *
 * Cada mensagem de assistente tem o seu diário em disco
 * (`userData/media-journal/<sessão>/<mensagem>/`), gravado a cada registro:
 * um crash no meio do turno não perde o estado anterior do que já foi tocado.
 */

export type PieceKind = 'motion' | 'design' | 'slides'

/** A peça dona de uma pasta registrada — o revert a re-registra ou a tira do registro. */
export interface PieceRef {
  kind: PieceKind
  id: string
  folder: string
  /** Entrada dentro da pasta (motion/slides). */
  entry?: string
  root?: string
  sessionId?: string
}

/**
 * Estado de um caminho (arquivo, pasta ou symlink) num instante.
 *
 * O diário guarda o estado ANTES (`backup`/`before`) e o DEPOIS (`after`).
 * No revert, o atual é comparado com o depois: só desfaz o que ainda está
 * como o turno deixou. Se outra conversa (ou a pessoa, no painel) mexeu
 * depois, o caminho é preservado e vira conflito.
 */
export interface PathState {
  exists: boolean
  /** sha256 do conteúdo (arquivo), da árvore (pasta) ou do alvo (symlink). */
  hash: string | null
  kind?: 'file' | 'dir' | 'symlink'
}

export function samePathState(a: PathState, b: PathState): boolean {
  return a.exists === b.exists && a.hash === b.hash && (a.kind ?? null) === (b.kind ?? null)
}

const ABSENT: PathState = { exists: false, hash: null }

function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Hash determinístico de um caminho — conteúdo, nomes e tipos, em ordem.
 * Pastas entram recursivamente; symlinks entram pelo TEXTO do alvo (sem
 * seguir, senão um link quebrado derrubaria a comparação).
 */
export async function hashPath(target: string): Promise<PathState> {
  const st = await fsp.lstat(target).catch(() => null)
  if (!st) return ABSENT
  if (st.isSymbolicLink()) {
    const link = await fsp.readlink(target).catch(() => null)
    return link === null
      ? { exists: true, hash: null, kind: 'symlink' }
      : { exists: true, hash: sha256(`link\0${link}`), kind: 'symlink' }
  }
  if (st.isFile()) {
    return { exists: true, hash: await hashFile(target), kind: 'file' }
  }
  if (st.isDirectory()) {
    const hash = crypto.createHash('sha256')
    for (const name of (await fsp.readdir(target)).sort()) {
      hash.update(`entry\0${name}\0`)
      const child = await hashPath(path.join(target, name))
      hash.update(child.exists ? `${child.kind ?? 'other'}:${child.hash ?? ''}` : 'absent')
      hash.update('\0')
    }
    return { exists: true, hash: hash.digest('hex'), kind: 'dir' }
  }
  return { exists: true, hash: sha256('other'), kind: 'file' }
}

export type JournalRecord =
  | {
      type: 'path'
      path: string
      /** Nome da cópia dentro de `files/` — null quando o caminho não existia. */
      backup: string | null
      piece?: PieceRef
      /** Entrada da galeria dona deste arquivo (artefato/documento). */
      owner?: string
      /** Estado do caminho DEPOIS do turno; ausente em diários antigos/crash. */
      after?: PathState
    }
  | {
      type: 'media'
      id: string
      before: MediaEntry | null
      /** A entrada DEPOIS do turno (o que o turno gravou). */
      after?: MediaEntry | null
    }

/** Registro pronto para aplicar: a cópia já resolvida para o caminho absoluto. */
export type RestoreRecord =
  | {
      type: 'path'
      path: string
      backupFile: string | null
      piece?: PieceRef
      owner?: string
      after?: PathState
    }
  | { type: 'media'; id: string; before: MediaEntry | null; after?: MediaEntry | null }

interface Scope {
  sessionId: string
  messageId?: string
  closed: boolean
  keys: Set<string>
  records: JournalRecord[]
  /** Fila serial do escopo: dois registros da mesma chave nunca correm juntos. */
  chain: Promise<unknown>
}

const storage = new AsyncLocalStorage<Scope>()
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,80}$/
const MANIFEST = 'journal.json'
/** Pasta do redo (unrevert) de uma sessão — fora do padrão de id de mensagem. */
export const REDO_DIR = '_redo'

export function journalRoot(): string {
  return path.join(app.getPath('userData'), 'media-journal')
}

export function sessionJournalDir(sessionId: string): string {
  if (!SAFE_SEGMENT.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(journalRoot(), sessionId)
}

function messageJournalDir(sessionId: string, messageId: string): string {
  if (!SAFE_SEGMENT.test(messageId)) throw new Error(`invalid message id: ${messageId}`)
  return path.join(sessionJournalDir(sessionId), messageId)
}

/** Abre o escopo do turno em volta de `fn`. A mensagem entra depois (bindMediaJournal). */
export function runWithMediaJournal<T>(sessionId: string, fn: () => T): T {
  if (!SAFE_SEGMENT.test(sessionId)) return fn()
  return storage.run({ sessionId, closed: false, keys: new Set(), records: [], chain: Promise.resolve() }, fn)
}

/**
 * Liga o escopo à mensagem de assistente do turno. Antes disso nada é
 * registrado: o diário mora na mensagem, e sem ela o revert não o acharia.
 */
export function bindMediaJournal(messageId: string): void {
  const scope = storage.getStore()
  if (!scope || !SAFE_SEGMENT.test(messageId)) return
  scope.messageId = messageId
}

/**
 * Fecha o escopo e grava o estado FINAL de cada caminho registrado.
 *
 * `closed` é marcado ANTES do trabalho assíncrono: o que ainda rodar herdando
 * o escopo (a capa da galeria tirada em segundo plano) já não é do turno e não
 * entra no diário. O `after` é o que permite o revert comparar "o worktree
 * ainda está como o turno deixou?" — sem ele, um turno antigo/crashado vira
 * conflito, nunca uma restauração às cegas.
 *
 * Nunca lança: o fim do turno não pode depender do diário.
 */
export async function closeMediaJournal(): Promise<void> {
  const scope = storage.getStore()
  if (!scope) return
  scope.closed = true
  if (!scope.messageId) return
  const s = scope as Scope & { messageId: string }
  try {
    await s.chain
    for (const record of s.records) {
      if (record.type !== 'path' || record.after) continue
      try {
        record.after = await hashPath(record.path)
      } catch (err) {
        // Sem estado final, o revert trata o caminho como conflito.
        console.error('[media-journal] hash final falhou:', record.path, err)
      }
    }
    await persistScope(s)
  } catch (err) {
    console.error('[media-journal] fechar o diário falhou:', err)
  }
}

function activeScope(): (Scope & { messageId: string }) | null {
  const scope = storage.getStore()
  if (!scope || scope.closed || !scope.messageId) return null
  return scope as Scope & { messageId: string }
}

export function mediaJournalActive(): boolean {
  return activeScope() !== null
}

/** `child` dentro de `parent` (ou igual)? */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Só o armazenamento do app entra no diário. A pasta de trabalho do modo código
 * tem o snapshot dela, e uma cópia do repositório aqui seria cara e duplicada.
 */
function isJournaledPath(target: string): boolean {
  const userData = app.getPath('userData')
  return isInside(userData, target) && !isInside(journalRoot(), target)
}

/**
 * Copia um arquivo ou uma pasta inteira. COPYFILE_FICLONE: no APFS é um clone
 * (as cópias dividem os blocos até alguém escrever), e em outros sistemas cai
 * para a cópia comum.
 */
export async function cloneInto(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source)
  if (stat.isDirectory()) {
    await fsp.mkdir(target, { recursive: true })
    for (const name of await fsp.readdir(source)) {
      await cloneInto(path.join(source, name), path.join(target, name))
    }
    return
  }
  if (stat.isSymbolicLink()) {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.symlink(await fsp.readlink(source), target)
    return
  }
  if (!stat.isFile()) return
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.copyFile(source, target, fs.constants.COPYFILE_FICLONE)
}

async function persistScope(scope: Scope & { messageId: string }): Promise<void> {
  const dir = messageJournalDir(scope.sessionId, scope.messageId)
  await writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify({ v: 2, records: scope.records }))
}

/** Enfileira no escopo — e uma falha do diário nunca derruba a tool que escrevia. */
function enqueue(scope: Scope & { messageId: string }, op: () => Promise<void>): Promise<void> {
  const run = scope.chain.then(op).catch((err) => {
    console.error('[media-journal] registro falhou:', err)
  })
  scope.chain = run
  return run
}

/**
 * Guarda o estado de `target` (arquivo ou pasta) ANTES da primeira mudança dele
 * neste turno. Chame logo antes de escrever, apagar ou substituir — dentro do
 * mesmo lock da escrita, para ninguém mudar o caminho entre a cópia e ela.
 */
export async function journalPath(target: string, piece?: PieceRef, owner?: string): Promise<void> {
  const scope = activeScope()
  if (!scope) return
  const resolved = path.resolve(target)
  if (!isJournaledPath(resolved)) return
  const key = `path:${resolved}`
  await enqueue(scope, async () => {
    if (scope.keys.has(key)) return
    // Uma pasta já registrada INTEIRA cobre o que estiver dentro dela.
    for (const record of scope.records) {
      if (record.type === 'path' && isInside(record.path, resolved)) return
    }
    scope.keys.add(key)
    const exists = await fsp.lstat(resolved).then(() => true, () => false)
    let backup: string | null = null
    if (exists) {
      backup = `b${scope.records.length}`
      await cloneInto(resolved, path.join(messageJournalDir(scope.sessionId, scope.messageId), 'files', backup))
    }
    scope.records.push({ type: 'path', path: resolved, backup, piece, owner })
    await persistScope(scope)
  })
}

/** Igualdade de duas entradas da galeria — a ordem das chaves não conta. */
function sameEntry(a: MediaEntry | undefined, b: MediaEntry | undefined): boolean {
  if (!a || !b) return a === b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (JSON.stringify((a as unknown as Record<string, unknown>)[key]) !== JSON.stringify((b as unknown as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

/**
 * Chamado por quem grava o índice da galeria, com o índice de antes e o de
 * depois: cada entrada criada, alterada ou removida guarda o estado anterior —
 * entrada por entrada, para o revert nunca restaurar o índice em bloco (o que
 * apagaria o que outro chat gravou no meio).
 */
export async function journalMediaIndex(previous: MediaEntry[], next: MediaEntry[]): Promise<void> {
  const scope = activeScope()
  if (!scope) return
  const before = new Map(previous.map((e) => [e.id, e]))
  const after = new Map(next.map((e) => [e.id, e]))
  const changed: Array<{ id: string; before: MediaEntry | null; after: MediaEntry | null }> = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (!sameEntry(before.get(id), after.get(id))) {
      changed.push({ id, before: before.get(id) ?? null, after: after.get(id) ?? null })
    }
  }
  if (changed.length === 0) return
  await enqueue(scope, async () => {
    let dirty = false
    for (const item of changed) {
      const existing = scope.records.find(
        (record): record is Extract<JournalRecord, { type: 'media' }> =>
          record.type === 'media' && record.id === item.id,
      )
      if (existing) {
        // O turno mexeu na mesma entrada de novo: o `before` continua sendo o
        // da PRIMEIRA mudança, e o `after` passa a ser o estado final do turno.
        existing.after = item.after
        dirty = true
        continue
      }
      scope.keys.add(`media:${item.id}`)
      scope.records.push({ type: 'media', id: item.id, before: item.before, after: item.after })
      dirty = true
    }
    if (dirty) await persistScope(scope)
  })
}

export interface LoadedJournal {
  dir: string
  records: JournalRecord[]
}

async function readManifest(dir: string): Promise<LoadedJournal | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8')) as { records?: JournalRecord[] }
    return Array.isArray(raw.records) ? { dir, records: raw.records } : null
  } catch {
    return null
  }
}

/** O diário de uma mensagem de assistente, se o turno tocou em alguma mídia. */
export async function readMediaJournal(sessionId: string, messageId: string): Promise<LoadedJournal | null> {
  if (!SAFE_SEGMENT.test(messageId)) return null
  return readManifest(messageJournalDir(sessionId, messageId))
}

/** O redo guardado pelo último revert da sessão. */
export async function readRedoJournal(sessionId: string): Promise<LoadedJournal | null> {
  return readManifest(path.join(sessionJournalDir(sessionId), REDO_DIR))
}

/**
 * Junta os diários de vários turnos (em ordem cronológica) num só: o revert
 * desfaz do turno escolhido até o fim, e o estado a restaurar de cada caminho
 * ou entrada é o do PRIMEIRO turno que o tocou. Uma pasta registrada inteira
 * cobre os caminhos de dentro dela registrados por turnos posteriores. Puro.
 */
export function mergeJournals(journals: LoadedJournal[]): RestoreRecord[] {
  const out: RestoreRecord[] = []
  const byKey = new Map<string, RestoreRecord>()
  const folders: string[] = []
  for (const journal of journals) {
    for (const record of journal.records) {
      if (record.type === 'media') {
        const key = `media:${record.id}`
        const existing = byKey.get(key)
        if (existing && existing.type === 'media') {
          // O `before` é o do PRIMEIRO turno; o `after` é o do ÚLTIMO que mexeu
          // — é esse estado que o worktree tem agora e que o revert vai
          // comparar.
          existing.after = record.after
          continue
        }
        const next = { ...record }
        byKey.set(key, next)
        out.push(next)
        continue
      }
      const resolved = path.resolve(record.path)
      const key = `path:${resolved}`
      const existing = byKey.get(key)
      if (existing && existing.type === 'path') {
        existing.after = record.after
        continue
      }
      if (folders.some((folder) => isInside(folder, resolved))) continue
      const next: RestoreRecord = {
        type: 'path',
        path: resolved,
        backupFile: record.backup ? path.join(journal.dir, 'files', record.backup) : null,
        piece: record.piece,
        owner: record.owner,
        after: record.after,
      }
      byKey.set(key, next)
      out.push(next)
      folders.push(resolved)
    }
  }
  return out
}

/**
 * Grava um diário pronto (o redo do revert): captura o estado ATUAL de cada
 * registro em `dir`, que é recriado do zero.
 */
export async function captureJournal(
  dir: string,
  records: RestoreRecord[],
  currentEntry: (id: string) => Promise<MediaEntry | null>,
): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true })
  const out: JournalRecord[] = []
  for (const record of records) {
    if (record.type === 'media') {
      out.push({ type: 'media', id: record.id, before: await currentEntry(record.id) })
      continue
    }
    const exists = await fsp.lstat(record.path).then(() => true, () => false)
    let backup: string | null = null
    if (exists) {
      backup = `b${out.length}`
      await cloneInto(record.path, path.join(dir, 'files', backup))
    }
    out.push({ type: 'path', path: record.path, backup, piece: record.piece, owner: record.owner })
  }
  await writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify({ v: 2, records: out }))
}

/**
 * Preenche o `after` de um diário já gravado — usado no redo do revert, depois
 * de aplicar: o estado final é o que o unrevert vai exigir encontrar para
 * poder desfazer sem apagar mudanças mais novas.
 */
export async function finalizeJournal(
  dir: string,
  currentEntry: (id: string) => Promise<MediaEntry | null>,
): Promise<void> {
  const loaded = await readManifest(dir)
  if (!loaded) return
  const records: JournalRecord[] = []
  for (const record of loaded.records) {
    if (record.type === 'media') {
      records.push({ ...record, after: await currentEntry(record.id) })
      continue
    }
    try {
      records.push({ ...record, after: await hashPath(record.path) })
    } catch (err) {
      console.error('[media-journal] hash final do redo falhou:', record.path, err)
      records.push(record)
    }
  }
  await writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify({ v: 2, records }))
}

/**
 * Devolve cada caminho ao estado do registro: apaga o que existe agora e, se
 * havia algo antes, põe a cópia de volta. Só dentro do armazenamento do app.
 *
 * A pasta vem antes do que está dentro dela: um arquivo registrado num turno e
 * a pasta dele num turno seguinte voltam os dois — a pasta ao estado do segundo
 * turno, e o arquivo, por cima, ao do primeiro.
 */
export async function restorePaths(
  records: RestoreRecord[],
  /** Revalida o caminho logo antes de trocar (quem decidiu leu antes). Recusado, fica como está. */
  stillSafe?: (record: Extract<RestoreRecord, { type: 'path' }>) => Promise<boolean>,
): Promise<RestoreRecord[]> {
  const skipped: RestoreRecord[] = []
  const paths = records
    .filter((record): record is Extract<RestoreRecord, { type: 'path' }> => record.type === 'path')
    .sort((a, b) => a.path.split(path.sep).length - b.path.split(path.sep).length)
  for (const record of paths) {
    if (!isJournaledPath(record.path)) continue
    if (stillSafe && !(await stillSafe(record))) {
      skipped.push(record)
      continue
    }
    await fsp.rm(record.path, { recursive: true, force: true })
    if (record.backupFile) await cloneInto(record.backupFile, record.path)
  }
  return skipped
}

/** Apaga diários: os das mensagens dadas, ou (sem lista) todos da sessão. */
export async function deleteMediaJournals(sessionId: string, messageIds?: string[]): Promise<void> {
  if (!SAFE_SEGMENT.test(sessionId)) return
  if (!messageIds) {
    await fsp.rm(sessionJournalDir(sessionId), { recursive: true, force: true })
    return
  }
  for (const id of messageIds) {
    if (SAFE_SEGMENT.test(id)) await fsp.rm(messageJournalDir(sessionId, id), { recursive: true, force: true })
  }
}

export async function deleteRedoJournal(sessionId: string): Promise<void> {
  if (!SAFE_SEGMENT.test(sessionId)) return
  await fsp.rm(path.join(sessionJournalDir(sessionId), REDO_DIR), { recursive: true, force: true })
}

/**
 * Limpeza de partida: diários mais velhos que `maxAgeMs` saem, e os de
 * conversas que não existem mais saem inteiros. Desfazer um turno de meses
 * atrás não é o caso de uso, e o diário guarda cópias.
 */
export async function pruneMediaJournals(
  maxAgeMs: number,
  sessionExists: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  const sessions = await fsp.readdir(journalRoot()).catch(() => [] as string[])
  for (const session of sessions) {
    const sessionDir = path.join(journalRoot(), session)
    if (!(await sessionExists(session).catch(() => true))) {
      await fsp.rm(sessionDir, { recursive: true, force: true })
      removed += 1
      continue
    }
    const messages = await fsp.readdir(sessionDir).catch(() => [] as string[])
    for (const message of messages) {
      const dir = path.join(sessionDir, message)
      const stat = await fsp.stat(dir).catch(() => null)
      if (stat && stat.mtimeMs < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true })
        removed += 1
      }
    }
    if ((await fsp.readdir(sessionDir).catch(() => ['x'])).length === 0) {
      await fsp.rm(sessionDir, { recursive: true, force: true })
    }
  }
  return removed
}
