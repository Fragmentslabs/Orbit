import type { Element, ElementContent, Root, RootContent } from "hast"

/**
 * A lone figure becomes a `<figure>` with a `<figcaption>`, using the `alt` as
 * the caption.
 *
 * This DIVERGES from standard Markdown on purpose: `alt` is alternative text, not
 * a caption, and no common renderer (GitHub, Obsidian, VS Code) displays it. The
 * switch is worth it because the file preview is a documentation reader,
 * where a screenshot almost always needs a label — and that is why
 * it is not worth it in the conversation, where the `alt` comes from the model.
 *
 * The caption is `aria-hidden`: it repeats the `alt`, which the screen reader already
 * announces. Without that, the same text would be read twice.
 */

/** Image extension at the end of the text — a sign that the alt is a file
 *  name, not a description. */
const LOOKS_LIKE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i

/** Case, accents and separator out: what is left is what matters for comparing. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
}

/** Last segment of the src, without extension and without query. */
function fileStem(src: string | undefined): string {
  if (!src) return ""
  const clean = src.split(/[?#]/)[0]
  const base = clean.split("/").pop() ?? ""
  return base.replace(/\.[^.]*$/, "")
}

/**
 * Was the alt written to be READ, or is it just filler?
 *
 * No word list of any language: a generic alt ("image", "figure 2")
 * is what repeats the file name, so what decides is the comparison with the
 * `src` itself — a rule that works in any language. A file name with
 * an extension does not become a caption either.
 */
export function isCaptionWorthy(alt: string, src?: string): boolean {
  const text = alt.trim()
  if (!text) return false
  if (LOOKS_LIKE_FILE.test(text)) return false
  const a = slug(text)
  const f = slug(fileStem(src))
  return !(a && f && a === f)
}

function isBlankText(node: ElementContent): boolean {
  return node.type === "text" && node.value.trim() === ""
}

function isImage(node: ElementContent): node is Element {
  return node.type === "element" && node.tagName === "img"
}

/** The figure and the caption, in the place of the paragraph that only had the image. */
function toFigure(img: Element, caption: string): Element {
  return {
    type: "element",
    tagName: "figure",
    properties: {},
    children: [
      img,
      {
        type: "element",
        tagName: "figcaption",
        // Repeats the alt, which the screen reader already announces.
        properties: { ariaHidden: "true" },
        children: [{ type: "text", value: caption }],
      },
    ],
  }
}

function convert(node: Root | Element): void {
  node.children = node.children.map((child) => {
    if (child.type !== "element") return child
    convert(child)
    if (child.tagName !== "p") return child
    // Only a LONE image becomes a figure: one in the middle of a text is an inline
    // illustration, and a row of them (the badges of a README) are not three
    // figures with three captions.
    const meaningful = child.children.filter((c) => !isBlankText(c))
    if (meaningful.length !== 1 || !isImage(meaningful[0])) return child
    const img = meaningful[0]
    const alt = typeof img.properties?.alt === "string" ? img.properties.alt : ""
    const src = typeof img.properties?.src === "string" ? img.properties.src : undefined
    return isCaptionWorthy(alt, src) ? toFigure(img, alt) : child
  }) as RootContent[] & ElementContent[]
}

/**
 * Runs at the END of the pipeline, after sanitize and harden: the elements we
 * create are ours and do not need to go through the sanitizer, and the image has already
 * arrived here in its final form (the blocked one became something else and is no longer an
 * `img`, so it gets no caption).
 */
export function rehypeFigureCaption() {
  return (tree: Root): void => convert(tree)
}
