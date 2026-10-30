import fsp from "node:fs/promises";
import path from "node:path";

/** A git repository found inside a working folder. */
export interface GitRepoEntry {
  /** Absolute path of the repository. */
  path: string;
  /** Short label: the folder name. */
  name: string;
  /**
   * Visible path to the repo: relative to the main folder when it is
   * inside it; outside it, prefixed with the name of the attached folder it lives in
   * (`other-project/api`). "" when it is the main folder itself.
   */
  relative: string;
}

/** Safety ceiling: a workspace with dozens of repos does not become an endless list. */
const MAX_REPOS = 12;
/** Ceiling for the whole set: several attached folders add up, and the total is limited too. */
const MAX_WORKSPACE_REPOS = 24;

/** Folders that are never worth a scan. */
const SKIP = new Set(["node_modules", "vendor"]);

async function hasGit(dir: string): Promise<boolean> {
  // `.git` is a folder in a normal repo and a FILE in a worktree and a submodule: existing is enough.
  try {
    await fsp.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return (
      entries
        .filter(
          (e) =>
            e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name),
        )
        .map((e) => path.join(dir, e.name))
        // Stable order: the panel's list cannot depend on how the disk
        // returned the folders.
        .sort((a, b) => a.localeCompare(b))
    );
  } catch {
    // Unreadable folder (permissions, vanished midway): no reason to fail the discovery.
    return [];
  }
}

/**
 * Discovers the repositories that live in a working folder.
 *
 * The folder itself enters when it is a repo; then the subfolders with their own git — the
 * case of a workspace with `front/` and `back/`, each with its own. With none at those
 * two levels, it goes one deeper: an umbrella folder that only holds projects, where the
 * repo lives in `project/something`.
 *
 * An empty list means "no repo here" — and then the panel goes on as it always
 * did, talking to the root folder.
 */
export async function discoverGitRepos(root: string): Promise<GitRepoEntry[]> {
  const found: GitRepoEntry[] = [];

  const add = (dir: string) => {
    if (found.length >= MAX_REPOS || found.some((r) => r.path === dir)) return;
    found.push({
      path: dir,
      name: path.basename(dir) || dir,
      relative: path.relative(root, dir).split(path.sep).join("/"),
    });
  };

  if (await hasGit(root)) add(root);

  const level1 = await subdirs(root);
  for (const dir of level1) {
    if (await hasGit(dir)) add(dir);
  }

  if (found.length === 0) {
    for (const dir of level1) {
      for (const deeper of await subdirs(dir)) {
        if (await hasGit(deeper)) add(deeper);
      }
    }
  }

  return found;
}

/** Normalized path for comparison: no trailing slash and always with '/'. */
function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

/** `dir` is inside `root` — or is it itself? */
function isInside(root: string, dir: string): boolean {
  const base = normalizePath(root);
  const target = normalizePath(dir);
  return target === base || target.startsWith(`${base}/`);
}

/** Path of `dir` from `root` ("" when they are the same folder). */
function relativeTo(root: string, dir: string): string {
  const base = normalizePath(root);
  const target = normalizePath(dir);
  if (target === base) return "";
  return target.slice(base.length + 1);
}

/**
 * Discovers the repositories of ALL the chat's working folders — the main one
 * and the attached ones.
 *
 * The first folder is the main one and provides the vocabulary of the labels: a repo inside
 * it has the path relative to it, as it always did. A repo that lives in an
 * attached folder, outside the main one, gets that folder's name as a prefix
 * (`other/api`) — it is what settles the doubt of which "api" this one is when two
 * attached folders have one. The absolute path remains the identity.
 *
 * A repo that already showed up in a previous folder does not come back: an attached folder that
 * is inside the main one is found by the main one's scan, and its label
 * stays the one from there.
 *
 * An empty list means "no repo in any folder" — and then the panel goes on
 * as it always did, talking to the main folder.
 */
export async function discoverWorkspaceRepos(
  roots: string[],
): Promise<GitRepoEntry[]> {
  const unique: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const key = normalizePath(root);
    if (unique.some((r) => normalizePath(r) === key)) continue;
    unique.push(root);
  }
  if (unique.length === 0) return [];

  const main = unique[0];
  const found: GitRepoEntry[] = [];
  const seen = new Set<string>();

  for (const root of unique) {
    if (found.length >= MAX_WORKSPACE_REPOS) break;
    for (const repo of await discoverGitRepos(root)) {
      if (found.length >= MAX_WORKSPACE_REPOS) break;
      const key = normalizePath(repo.path);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        ...repo,
        // Inside the main one the path is already relative to it; outside, the name of the
        // attached folder is what gives a readable path.
        relative: isInside(main, repo.path)
          ? relativeTo(main, repo.path)
          : [path.basename(normalizePath(root)), repo.relative]
              .filter(Boolean)
              .join("/"),
      });
    }
  }

  return found;
}
