import type { PluggableList } from "unified"
import { defaultRehypePlugins } from "streamdown"

import { rehypeFigureCaption } from "./figure-caption"

/**
 * The streamdown pipeline with `data:` allowed in the images' `src`.
 *
 * The figures of a Markdown read from disk become a data URL — it is the file's
 * folder that resolves the relative path, and only main knows it. Except that the
 * default sanitizer (hast-util-sanitize) accepts only http and https in
 * `src`, so the attribute was REMOVED even before harden, which in turn
 * announced "[Image blocked]" for not finding any src.
 *
 * We start from streamdown's own defaults and swap ONLY the sanitize
 * entry: that way the rest of the pipeline (rehype-raw, harden and what they
 * add in the future) keeps being theirs, and not a copy of ours that
 * would age in silence.
 *
 * It applies only to the local file preview, and not to the chat
 * messages: there the content comes from the model, and the protection is against it. Here the figure
 * is a repository file the user opened.
 */

/** What hast-util-sanitize calls a scheme — only the part we touch. */
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
    // The order of the entries is what defines the pipeline order — mapping preserves it.
    if (name !== "sanitize" || !Array.isArray(plugin)) return plugin
    const [fn, schema] = plugin as [unknown, SanitizeSchema]
    return [fn, withDataImages(schema)] as unknown as PluggableList[number]
  }),
  // Last: the caption is ours and does not need to go through the sanitizer, and the
  // image has already arrived in its final form.
  rehypeFigureCaption,
]
