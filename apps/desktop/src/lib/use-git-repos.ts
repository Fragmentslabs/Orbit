"use client";

import { useEffect, useState } from "react";
import type { GitRepoEntry, GitReposResult } from "@/src/lib/folders";

/**
 * Os repositórios git que vivem nas pastas de trabalho do chat — a principal e
 * as anexadas. Em cada uma: a própria pasta quando é repo, mais as subpastas
 * com git próprio (`front/`, `back/`, cada uma com o seu). Sem nenhum, devolve
 * lista vazia — e aí quem consome volta a falar com a pasta principal, como
 * sempre foi.
 *
 * A varredura é do main (toca o disco), então roda uma vez por mudança de
 * pasta — e não a cada render. Quem precisa da lista em dois lugares (o painel
 * de arquivos e a leitura de alterações) chama o hook nos dois: a resposta é a
 * mesma e o custo é uma varredura de diretório.
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
