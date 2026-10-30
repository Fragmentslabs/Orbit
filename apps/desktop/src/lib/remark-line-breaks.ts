import { defaultRemarkPlugins } from "streamdown"
import type { Plugin, PluggableList } from "unified"

/**
 * A single line break becomes <br> — the GitHub comments' rule.
 *
 * CommonMark joins the lines of a paragraph into a single text: "first
 * idea\nsecond idea" comes out as "first idea second idea". In a long model answer
 * that passes; in a chat message it WIPES OUT information — whoever
 * writes one idea per line is separating ideas, not writing a paragraph.
 *
 * The rule only holds where the break is text: paragraph and heading. List, table,
 * code block and quote already carry the break in the STRUCTURE of the markdown and
 * do not go through here — inside a ``` of code one line per line
 * would keep being one line per line anyway.
 *
 * It is `remark-breaks` without the dependency: the transformation is twenty lines and
 * it avoids a version pinned to a plugin we do not have otherwise.
 */

/** The minimum of an mdast node this transformation touches — without @types/mdast. */
export interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/** A text node with breaks becomes text + `break` + text… */
function splitSoftBreaks(node: MdastNode): MdastNode[] {
  if (node.type !== "text" || typeof node.value !== "string") return [node]
  if (!node.value.includes("\n")) return [node]

  const chunks = node.value.split("\n")
  // A break at the END of the text is the end of the paragraph, not a blank line.
  while (chunks.length > 1 && chunks[chunks.length - 1] === "") chunks.pop()

  const out: MdastNode[] = []
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) out.push({ type: "break" })
    if (chunk) out.push({ type: "text", value: chunk })
  }
  return out
}

/** The transformation itself — exported for the test to exercise it on the tree. */
export function applyChatLineBreaks(tree: MdastNode): void {
  const walk = (node: MdastNode): void => {
    if (!node.children) return
    if (node.type === "paragraph" || node.type === "heading") {
      node.children = node.children.flatMap(splitSoftBreaks)
      return
    }
    node.children.forEach(walk)
  }
  walk(tree)
}

export const remarkChatLineBreaks: Plugin = () => (tree) =>
  applyChatLineBreaks(tree as unknown as MdastNode)

/** The streamdown pipeline (GFM) + the chat line break.
 *
 * `remarkPlugins` in streamdown REPLACES the defaults instead of adding to them — hence
 * starting from `defaultRemarkPlugins` here, so that table, autolink and the like
 * keep working. */
export const chatRemarkPlugins: PluggableList = [
  ...Object.values(defaultRemarkPlugins),
  remarkChatLineBreaks,
]
