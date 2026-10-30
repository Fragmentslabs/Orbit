/**
 * Matching and replacement on the renderer side.
 *
 * It is the small sibling of main's engine (`electron/lib/workspace-search.ts`), and
 * it exists for one reason only: the editor buffer does not go through main. Replacing
 * in the open file has to use EXACTLY the same rules as the occurrence list —
 * whole word, case and format preservation —, otherwise the preview shows one thing
 * and the key applies another.
 */

import type { WsMatchOptions } from "@/src/lib/ipc";

/** `\b` does not separate in `snake_case`; the boundaries are explicit. */
export function buildMatcher(
  query: string,
  options: WsMatchOptions,
): RegExp | null {
  const flags = options.caseSensitive ? "g" : "gi";
  try {
    if (options.regex) return new RegExp(query, flags);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
    return new RegExp(
      options.wholeWord ? `(?<!\\w)${escaped}(?!\\w)` : escaped,
      flags,
    );
  } catch {
    return null;
  }
}

/** The replacement in the format of the text it is swapping. */
export function applyCase(matched: string, replacement: string): string {
  if (replacement === "" || matched === "") return replacement;
  const upper = matched.toUpperCase();
  const lower = matched.toLowerCase();
  if (upper === lower) return replacement;
  if (matched === upper) return replacement.toUpperCase();
  if (matched === lower) return replacement.toLowerCase();
  const rest = matched.slice(1);
  if (matched[0] === matched[0].toUpperCase() && rest === rest.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Replaces in the whole text and returns how many occurrences were hit. */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  options: WsMatchOptions,
): { text: string; count: number } {
  const pattern = buildMatcher(query, options);
  if (!pattern || query === "") return { text, count: 0 };
  let count = 0;
  const next = text.replace(pattern, (matched) => {
    count += 1;
    return options.preserveCase ? applyCase(matched, replacement) : replacement;
  });
  return { text: next, count };
}

/**
 * The line as it would look after the replacement, swapping only the occurrence
 * being shown — the preview answers "what does this stretch become?".
 */
export function previewLine(
  line: string,
  hit: { column: number; length: number },
  replacement: string,
  options: WsMatchOptions,
): string {
  const start = Math.max(0, hit.column - 1);
  const matched = line.slice(start, start + hit.length);
  if (matched === "") return line;
  const next = options.preserveCase
    ? applyCase(matched, replacement)
    : replacement;
  return line.slice(0, start) + next + line.slice(start + hit.length);
}
