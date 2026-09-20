import path from 'node:path'

/**
 * Guardas do `fs:writeFile` — o único canal pelo qual o renderer escreve em
 * disco (o painel de arquivos).
 *
 * As tools do agente já têm o `resolveSafePath` ([tools/context.ts]); isto é o
 * equivalente para o painel. Vale registrar o limite honesto: as pastas do
 * workspace vivem no renderer (localStorage), então é o próprio renderer que
 * informa as raízes aqui. Ou seja, a contenção é rede contra BUG de caminho —
 * um arquivo aberto de um lugar e salvo em outro —, não fronteira de
 * segurança. O que realmente limita o estrago são as checagens de arquivo
 * existente, `.git` e binário aplicadas no handler.
 */

export type PathVerdict =
  | { ok: true; resolved: string }
  | { ok: false; reason: 'outside-workspace' | 'git-internal' }

/** Um segmento `.git` em qualquer posição do caminho. */
function touchesGitInternals(resolved: string): boolean {
  return resolved.split(/[\\/]+/).includes('.git')
}

function isInside(root: string, resolved: string): boolean {
  const rel = path.relative(path.resolve(root), resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * O caminho pode ser escrito? Mesma aritmética de contenção do
 * `resolveSafePath`, mais a recusa do diretório do git: um save acidental
 * dentro de `.git` corrompe o repositório, e nada que o painel abre para ler
 * precisa ser reescrito ali.
 */
export function checkWritePath(target: string, roots: string[]): PathVerdict {
  const resolved = path.resolve(target)
  if (touchesGitInternals(resolved)) return { ok: false, reason: 'git-internal' }
  const allowed = roots.length > 0 && roots.some((root) => isInside(root, resolved))
  if (!allowed) return { ok: false, reason: 'outside-workspace' }
  return { ok: true, resolved }
}
