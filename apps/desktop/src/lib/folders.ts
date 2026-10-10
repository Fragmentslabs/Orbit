/**
 * Vocabulário compartilhado da aba de pastas.
 *
 * Os tipos e helpers que atravessam as três peças da aba ficam aqui, e não
 * dentro de um dos componentes, porque nenhum deles é dono do vocabulário: o
 * navegador produz as referências de arquivo, o visualizador as consome e a aba
 * liga os dois. Sem este módulo, um teria de importar o outro só para conhecer
 * `ViewedFile`.
 */

import type { GitFileStatus } from "@/src/components/ai/file-tree";

export interface DirEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface CommitFileEntry {
  status: "added" | "modified" | "deleted" | "renamed";
  path: string;
}

export interface CommitEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
  body: string;
  files: CommitFileEntry[];
  refs: string[];
  onDefault: boolean;
  pushed: boolean;
}

export type ReaddirResult =
  { ok: true; entries: DirEntryInfo[] } | { ok: false; error: string };

export type ReadFileResult =
  { content: string; mtimeMs?: number } | { error: string };

export type GitLogResult =
  | { ok: true; commits: CommitEntry[]; hasMore: boolean }
  | { ok: false; error: string };

/**
 * O arquivo que o visualizador está mostrando, e de onde ele vem.
 *
 * É a única fonte sobre "que arquivo é este": se está no working tree
 * (`live`) ou congelado em um commit (`commit`). O que se faz com ele — ler o
 * conteúdo ou ver o diff — é a lente do visualizador, não um estado paralelo.
 */
export type ViewedFile =
  | { kind: "live"; path: string; relPath: string | null; deleted: boolean }
  | {
      kind: "commit";
      repoPath: string;
      hash: string;
      path: string;
      deleted: boolean;
    };

/** Entrada do git status por caminho absoluto (chave do mapa). */
export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
}

export type GitStatusResult =
  { ok: true; entries: GitStatusEntry[] } | { ok: false; error: string };

/**
 * Um repositório que vive dentro da pasta de trabalho: a própria pasta, quando
 * ela é repo, ou uma subpasta com git próprio (`front/`, `back/`). `relative`
 * é o caminho até ele a partir da pasta de trabalho ("" quando é ela mesma).
 */
export interface GitRepoEntry {
  path: string;
  name: string;
  relative: string;
}

export type GitReposResult =
  { ok: true; repos: GitRepoEntry[] } | { ok: false; error: string };

/**
 * O repositório dono de um caminho, ou `null` se nenhum o contém.
 *
 * O de prefixo MAIS LONGO, e não o primeiro que casar: num espaço onde a pasta
 * raiz também é repo, o caminho dela é prefixo de todo repo aninhado — e
 * `front/src/x.ts` pertence ao `front`, não à raiz.
 */
export function repoForPath(
  repos: GitRepoEntry[],
  filePath: string,
): string | null {
  const target = filePath.replace(/\\/g, "/");
  let best: GitRepoEntry | null = null;
  for (const repo of repos) {
    const root = repo.path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    if (!target.startsWith(root + "/")) continue;
    if (!best || root.length > best.path.replace(/[\\/]+$/, "").length) {
      best = repo;
    }
  }
  return best?.path ?? null;
}

export type DiffResult =
  { ok: true; patch: string } | { ok: false; error: string };

/**
 * A lente sobre o arquivo em foco: o conteúdo em si ou o diff dele.
 *
 * Quem escolhe é o pai — a lista de alterações abre um arquivo direto no diff,
 * a árvore completa abre no conteúdo —, e o visualizador só obedece.
 */
export type ViewerLens = "content" | "diff";

/**
 * Patch completo do working tree — todos os arquivos alterados num texto só,
 * que o `parsePatch` separa de volta. É o que alimenta a visão empilhada.
 */
export type GitWorkingDiffResult =
  { ok: true; patch: string } | { ok: false; error: string };

/** Linhas adicionadas/removidas de um arquivo (working tree contra HEAD). */
export interface LineStat {
  added: number;
  deleted: number;
}

export type GitNumstatResult =
  { ok: true; stats: Record<string, LineStat> } | { ok: false; error: string };

/** Arquivo excluído no working tree (fantasma no tree, não existe em disco). */
export interface DeletedEntry {
  path: string;
  name: string;
}

/** Junta a raiz do repo com um caminho relativo (separadores '/' no relPath). */
export function joinPath(root: string, relPath: string) {
  const base = root.replace(/[\\/]+$/, "");
  return `${base}/${relPath.replace(/\\/g, "/")}`;
}

export function getBaseName(p: string) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

export function isImageFile(p: string) {
  return IMAGE_FILE_RE.test(p);
}

export function getBreadcrumbs(rootPath: string, filePath: string): string[] {
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const file = filePath.replace(/\\/g, "/");
  if (!root || !file.startsWith(root)) return [];
  const relative = file.slice(root.length + 1);
  const parts = relative.split("/");
  return [getBaseName(rootPath), ...parts];
}
