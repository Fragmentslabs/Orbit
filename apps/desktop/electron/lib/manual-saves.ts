import path from 'node:path'

/**
 * Registro do que o USUÁRIO salvou à mão pelo painel de arquivos.
 *
 * O snapshot do turno difere a pasta INTEIRA (`capture`/`diff` em
 * [snapshot/index.ts]), então um Ctrl+S durante um turno entrava no diff e o
 * engine contava aquele arquivo como escrita do agente: o
 * `[Verified record: ...]` passava a afirmar que o modelo alterou algo que ele
 * nunca tocou, e era justamente essa linha que existia para não mentir.
 *
 * Aqui ficam os caminhos salvos pela pessoa; o `verifyTurn` os subtrai antes
 * de montar o veredito do turno.
 */

/**
 * Caminho absoluto (normalizado pelo `path.resolve`) → instante do último
 * save. Por instante, e não "limpa no começo do turno": dois turnos podem
 * rodar ao mesmo tempo na mesma pasta, e o começo de um apagaria os saves que
 * a pessoa fez durante o outro.
 */
const saved = new Map<string, number>()
/** Ninguém consulta saves mais velhos que o turno mais longo. */
const SAVE_TTL_MS = 24 * 60 * 60 * 1000

export function recordManualSave(absPath: string, at = Date.now()): void {
  saved.set(path.resolve(absPath), at)
  const cutoff = at - SAVE_TTL_MS
  for (const [file, time] of saved) if (time < cutoff) saved.delete(file)
}

/**
 * Os caminhos salvos à mão dentro deste diretório desde `since` (o começo do
 * turno), relativos a ele e com separador '/' — o mesmo formato em que o
 * `git diff --name-only` devolve. O que foi salvo ANTES do turno já está no
 * `start` e nunca aparece no diff; contá-lo criaria o erro inverso — o agente
 * editar esse arquivo agora e a alteração dele ser subtraída do registro.
 */
export function manualSavesUnder(directory: string, since = 0): Set<string> {
  const root = path.resolve(directory)
  const result = new Set<string>()
  for (const [abs, at] of saved) {
    if (at < since) continue
    const rel = path.relative(root, abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      result.add(rel.replace(/\\/g, '/'))
    }
  }
  return result
}

/** Só para teste: zera tudo entre casos. */
export function resetManualSaves(): void {
  saved.clear()
}

/**
 * Remove do diff unificado as seções dos arquivos indicados.
 *
 * O `snapshot.patch` não é só bookkeeping: alimenta a aba Diff e a lista de
 * arquivos do card da mensagem ([code-message.tsx]). Filtrar só o
 * `snapshot.files` deixaria o arquivo do usuário sumir do registro verificado
 * e continuar aparecendo na tela como obra do agente.
 *
 * Corta nos limites de `diff --git`, que é como o git sempre separa os
 * arquivos — nenhuma linha de conteúdo começa assim, porque no corpo de um
 * diff toda linha vem prefixada por espaço, '+', '-' ou '\'.
 */
export function stripFilesFromPatch(patch: string, exclude: Set<string>): string {
  if (!patch || exclude.size === 0) return patch
  const sections = patch.split(/^(?=diff --git )/m)
  const kept = sections.filter((section) => {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(section)
    if (!header) return true
    return !exclude.has(header[1]) && !exclude.has(header[2])
  })
  return kept.join('')
}
