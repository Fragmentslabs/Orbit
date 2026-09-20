import type { PluggableList } from "unified"
import { defaultRehypePlugins } from "streamdown"

import { rehypeFigureCaption } from "./figure-caption"

/**
 * O pipeline do streamdown com `data:` liberado no `src` das imagens.
 *
 * As figuras de um Markdown lido do disco viram data URL — é a pasta do
 * arquivo que resolve o caminho relativo, e só o main a conhece. Só que o
 * sanitizador padrão (hast-util-sanitize) aceita apenas http e https em
 * `src`, então o atributo era REMOVIDO antes mesmo do harden, que por sua vez
 * anunciava "[Image blocked]" por não achar src nenhum.
 *
 * Partimos dos defaults do próprio streamdown e trocamos SÓ a entrada do
 * sanitize: assim o resto do pipeline (rehype-raw, harden e o que eles
 * acrescentarem no futuro) continua sendo o deles, e não uma cópia nossa que
 * envelheceria em silêncio.
 *
 * Vale só para a pré-visualização de arquivo local, e não para as mensagens do
 * chat: ali o conteúdo vem do modelo, e a proteção é contra ele. Aqui a figura
 * é um arquivo do repositório que o usuário abriu.
 */

/** O que o hast-util-sanitize chama de esquema — só a parte que mexemos. */
interface SanitizeSchema {
  protocols?: Record<string, string[]>
}

function withDataImages(schema: SanitizeSchema): SanitizeSchema {
  const src = schema.protocols?.src ?? []
  if (src.includes("data")) return schema
  return { ...schema, protocols: { ...schema.protocols, src: [...src, "data"] } }
}

export const localImageRehypePlugins: PluggableList = [
  ...Object.entries(defaultRehypePlugins).map(([name, plugin]) => {
    // A ordem das entradas é o que define a ordem do pipeline — mapear preserva.
    if (name !== "sanitize" || !Array.isArray(plugin)) return plugin
    const [fn, schema] = plugin as [unknown, SanitizeSchema]
    return [fn, withDataImages(schema)] as unknown as PluggableList[number]
  }),
  // Por último: a legenda é nossa e não precisa passar pelo sanitizador, e a
  // imagem já chegou na forma final.
  rehypeFigureCaption,
]
