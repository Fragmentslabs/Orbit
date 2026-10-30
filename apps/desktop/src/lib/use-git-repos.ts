"use client";

import { useEffect, useState } from "react";
import type { GitRepoEntry, GitReposResult } from "@/src/lib/folders";

/**
 * The git repositories that live in the chat's working folders — the main one and
 * the attached ones. In each one: the folder itself when it is a repo, plus the subfolders
 * with their own git (`front/`, `back/`, each with its own). With none, it returns an
 * empty list — and then whoever consumes it goes back to talking to the main folder, as
 * it always was.
 *
 * The scan is main's (it touches the disk), so it runs once per folder
 * change — and not on every render. Whoever needs the list in two places (the file
 * panel and the changes view) calls the hook in both: the answer is the
 * same and the cost is one directory scan.
 */
export function useGitRepos(folders: string[]): GitRepoEntry[] {
  const [repos, setRepos] = useState<GitRepoEntry[]>([]);

  useEffect(() => {
    if (folders.length === 0) {
      setRepos([]);
      return;
    }
    let cancelled = false;
    void window.ipcRenderer
      .invoke("git:repos", folders)
      .then((result) => {
        if (cancelled) return;
        const r = result as GitReposResult;
        setRepos(r.ok ? r.repos : []);
      });
    return () => {
      cancelled = true;
    };
  }, [folders]);

  return repos;
}
