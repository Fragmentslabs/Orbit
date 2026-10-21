import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Concorrência entre chats/tools no MESMO recurso.
 *
 * O main é um processo só, então uma fila em memória por chave basta para que
 * duas edições (de chats diferentes, ou do agente e do editor da UI) não
 * intercalem leitura e gravação do mesmo arquivo. A chave é a PASTA da
 * composição/canvas — que uma edição mexe em mais de um arquivo por vez
 * (canvas.json + artboards, index.html + assets) — ou o id do artefato.
 *
 * Combinado com writeFileAtomic, o arquivo nunca fica pela metade; e como a
 * leitura de um edit acontece DENTRO do lock, um edit desatualizado falha (o
 * oldText não casa) em vez de sobrescrever o trabalho do outro chat.
 */
const queues = new Map<string, Promise<unknown>>()

export function withAssetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

/** Grava via tmp + rename: um crash no meio nunca deixa o arquivo pela metade. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
