/**
 * Casamento e substituição do lado do renderer.
 *
 * É o irmão pequeno do motor do main (`electron/lib/workspace-search.ts`), e
 * existe por um motivo só: o buffer do editor não passa pelo main. Substituir
 * no arquivo aberto tem que usar EXATAMENTE as mesmas regras da lista de
 * ocorrências — palavra inteira, caixa e preservação de formato —, senão a
 * prévia mostra uma coisa e a tecla aplica outra.
 */

import type { WsMatchOptions } from "@/src/lib/ipc";

/** `\b` não separa em `snake_case`; as fronteiras vão explícitas. */
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

/** A substituição no formato do texto que ela está trocando. */
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

/** Troca no texto inteiro e devolve quantas ocorrências caíram. */
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
 * A linha como ela ficaria depois da substituição, trocando só a ocorrência
 * que está sendo mostrada — a prévia responde "este trecho vira o quê?".
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
