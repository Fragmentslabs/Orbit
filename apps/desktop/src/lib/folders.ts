/**
 * Shared vocabulary of the folders tab.
 *
 * The types and helpers that cross the three pieces of the tab live here, and not
 * inside one of the components, because none of them owns the vocabulary: the
 * navigator produces the file references, the viewer consumes them and the tab
 * connects the two. Without this module, one would have to import the other just to know
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
 * The file the viewer is showing, and where it comes from.
 *
 * It is the only source about "which file is this": whether it is in the working tree
 * (`live`) or frozen in a commit (`commit`). What is done with it — reading the
 * content or seeing the diff — is the viewer lens, not a parallel state.
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

/** Git status entry by absolute path (key of the map). */
export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
}

export type GitStatusResult =
  { ok: true; entries: GitStatusEntry[] } | { ok: false; error: string };

/**
 * A repository that lives inside the working folder: the folder itself, when
 * it is a repo, or a subfolder with its own git (`front/`, `back/`). `relative`
 * is the path to it from the working folder ("" when it is the folder itself).
 */
export interface GitRepoEntry {
  path: string;
  name: string;
  relative: string;
}

export type GitReposResult =
  { ok: true; repos: GitRepoEntry[] } | { ok: false; error: string };

/**
 * Which of the paths contains the file, or `null` if none does.
 *
 * The one with the LONGEST prefix, and not the first that matches: in a space where the root
 * folder is also a repo, its path is a prefix of every nested repo — and
 * `front/src/x.ts` belongs to `front`, not to the root. The same holds for the working
 * folders: an attached folder that is inside the main one owns its
 * files.
 */
export function folderForPath(
  folders: string[],
  filePath: string,
): string | null {
  const target = filePath.replace(/\\/g, "/");
  let best: string | null = null;
  let bestLen = -1;
  for (const folder of folders) {
    const root = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    if (!target.startsWith(`${root}/`) || root.length <= bestLen) continue;
    best = folder;
    bestLen = root.length;
  }
  return best;
}

/** The repository that owns a path, or `null` if none contains it. */
export function repoForPath(
  repos: GitRepoEntry[],
  filePath: string,
): string | null {
  return folderForPath(
    repos.map((repo) => repo.path),
    filePath,
  );
}

/**
 * Distributes files across the working folders that contain them — the base of the changes
 * list when the chat has more than one folder.
 *
 * The file counts once only: it stays with the most specific folder, so an attached folder
 * inside the main one does not show the same changes twice. A file
 * that is in no folder (the reading is from an instant ago, right after
 * switching the folders) goes to `fallback`, instead of vanishing from the screen.
 *
 * The order follows `folders` — the main one first —, and what belongs to
 * none stays at the end.
 */
export function groupByFolder<T extends { path: string }>(
  folders: string[],
  files: T[],
  fallback: string,
): Array<{ folder: string; files: T[] }> {
  const byFolder = new Map<string, T[]>();
  for (const file of files) {
    const owner = folderForPath(folders, file.path) ?? fallback;
    const list = byFolder.get(owner);
    if (list) list.push(file);
    else byFolder.set(owner, [file]);
  }

  const rank = (folder: string) => {
    const index = folders.indexOf(folder);
    return index === -1 ? folders.length : index;
  };
  return [...byFolder]
    .map(([folder, list]) => ({ folder, files: list }))
    .sort((a, b) => rank(a.folder) - rank(b.folder));
}

export type DiffResult =
  { ok: true; patch: string } | { ok: false; error: string };

/**
 * The lens over the file in focus: the content itself or its diff.
 *
 * The parent is the one that chooses — the changes list opens a file straight into the diff,
 * the full tree opens into the content —, and the viewer just obeys.
 */
export type ViewerLens = "content" | "diff";

/**
 * Full patch of the working tree — every changed file in a single text,
 * which `parsePatch` splits back. It is what feeds the stacked view.
 */
export type GitWorkingDiffResult =
  { ok: true; patch: string } | { ok: false; error: string };

/** Lines added/removed of a file (working tree against HEAD). */
export interface LineStat {
  added: number;
  deleted: number;
}

export type GitNumstatResult =
  { ok: true; stats: Record<string, LineStat> } | { ok: false; error: string };

/** File deleted in the working tree (a ghost in the tree, it does not exist on disk). */
export interface DeletedEntry {
  path: string;
  name: string;
}

/** Joins the repo root with a relative path ('/' separators in relPath). */
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
