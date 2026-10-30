/**
 * Figures of a Markdown read from disk.
 *
 * The preview runs on the app's origin, so a `./images/x.png` would resolve
 * against it and not against the open file — the image showed up broken in
 * every document that references a figure. Main resolves the paths against the
 * file's folder and returns data URLs; what this module does is find what to
 * ask for and swap it afterwards.
 *
 * There are three forms, which are the ones that show up in documentation:
 *   ![alt](path "title")      — the common one
 *   ![alt](<path with spaces>)  — the one for a path with spaces
 *   <img src="path">           — loose HTML in the middle of the text
 *
 * The <> form needs its own regex: its path may have spaces, and
 * the common regex stops on purpose at the first blank (otherwise it would swallow the
 * "title" that comes after).
 */
const MD_IMAGE_ANGLE = /(!\[[^\]]*\]\(\s*<)([^>]+)(?=>)/g
const MD_IMAGE_PLAIN = /(!\[[^\]]*\]\(\s*)([^)<\s]+)/g
const HTML_IMAGE_SRC = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)/gi

const PATTERNS = [MD_IMAGE_ANGLE, MD_IMAGE_PLAIN, HTML_IMAGE_SRC]

/** Address the renderer already knows how to load by itself — http, data, orbit-*. */
export function isExternalSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")
}

/** The relative paths referenced, without repetition. */
export function markdownImageSources(markdown: string): string[] {
  const found = new Set<string>()
  for (const re of PATTERNS) {
    // The regex is global and keeps its position between calls: without resetting it, the second
    // read of the same text would start in the middle.
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(markdown))) {
      const src = match[2]
      if (src && !isExternalSrc(src)) found.add(src)
    }
  }
  return [...found]
}

/**
 * Swaps the relative paths for the resolved data URLs.
 *
 * What is not in the map stays as it came: a figure that does not exist in the repository
 * stays broken, and that is how one notices it is missing.
 */
export function withResolvedImages(
  markdown: string,
  resolved: Record<string, string>,
): string {
  if (Object.keys(resolved).length === 0) return markdown
  const swap = (_all: string, head: string, src: string) => `${head}${resolved[src] ?? src}`
  return PATTERNS.reduce((text, re) => text.replace(re, swap), markdown)
}
