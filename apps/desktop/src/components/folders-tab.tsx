"use client";

/**
 * A aba de pastas: o painel de leitura à esquerda, o índice à direita.
 *
 * O índice à direita tem três abas — Arquivos, Alterações e Commits — e o painel
 * da esquerda tem dois modos, escolhidos pelas duas primeiras:
 *
 * - **Arquivos** — a árvore completa à direita, um arquivo só à esquerda. É o
 *   modo de trabalho: procurar, abrir, editar.
 * - **Alterações** — a lista dos modificados à direita, todos os diffs
 *   empilhados à esquerda. É o modo de leitura: comparar o que mudou sem
 *   perder de vista o que já foi lido. Aqui clicar num arquivo não troca o que
 *   está na tela — só rola até a seção dele.
 * - **Commits** — o histórico, que é só do índice: a esquerda fica como estava,
 *   e o arquivo de um commit abre nela quando se clica nele.
 *
 * Aqui vive só o que é do conjunto: qual modo está ativo, que arquivo está em
 * foco, com que lente ele abre, até onde rolar e se há rascunho a perder.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "@/lib/workspace-context";
import { FolderSelector } from "@/src/components/folder-selector";
import { FileViewer } from "@/src/components/file-viewer";
import { FileBrowser, type BrowserTab } from "@/src/components/file-browser";
import { ChangesView, type RevealRequest } from "@/src/components/changes-view";
import type { ViewedFile, ViewerLens } from "@/src/lib/folders";
import { useGitRepos } from "@/src/lib/use-git-repos";

const FILE_PANEL_MIN_PX = 200;

/**
 * O que está em foco: o arquivo E a lente sobre ele.
 *
 * Os dois andam juntos porque descrevem a mesma tela — o arquivo sozinho não
 * diz se o painel mostra o texto ou o diff dele. Quem escolhe a lente é quem
 * abre: a lista de alterações abre no diff, a árvore completa no conteúdo.
 */
interface ViewerTarget {
  file: ViewedFile;
  lens: ViewerLens;
}

/**
 * Identidade do arquivo aberto no visualizador.
 *
 * A chave existe para o visualizador renascer ao trocar de arquivo: o estado
 * interno dele (rascunho, conflito, patch) é todo do arquivo anterior. Ela é
 * derivada do arquivo, e não um contador, para que reabrir o MESMO arquivo não
 * jogue fora o que está na tela — a lente fica de fora de propósito: trocar de
 * lente é do visualizador, e remontá-lo perderia o rascunho.
 */
function viewerKey(file: ViewedFile | undefined): string {
  if (!file) return "empty";
  return file.kind === "commit"
    ? `commit:${file.hash}:${file.path}`
    : `live:${file.path}:${file.deleted ? "deleted" : "file"}`;
}

export function FoldersTab() {
  const { t } = useTranslation();
  const { folders, setFolders } = useWorkspace();
  // Quem tem git nesta pasta: a raiz e/ou as subpastas com repo próprio. A
  // leitura das alterações usa a lista para mostrar o espaço inteiro, com cada
  // projeto debaixo do seu nome — e não só o diff da pasta raiz, que num
  // workspace não é repo nenhum.
  const repos = useGitRepos(folders);

  const [tab, setTab] = useState<BrowserTab>("files");
  /**
   * O modo do painel da esquerda. Ele NÃO é a aba do índice: a aba de commits é
   * só do índice, e os diffs empilhados (ou o arquivo aberto) não têm por que
   * sumir porque se foi olhar o histórico.
   */
  const [leftMode, setLeftMode] = useState<"files" | "changes">("files");
  const [target, setTarget] = useState<ViewerTarget>();
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [changesReload, setChangesReload] = useState(0);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(true);
  /** Espelho de "há rascunho" para leitura dentro dos callbacks de troca. */
  const dirtyRef = useRef(false);
  /** Cresce a cada pedido de foco: repetir o clique no mesmo arquivo vale de novo. */
  const revealNonce = useRef(0);

  const handleDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next;
  }, []);

  const handleLensChange = useCallback((lens: ViewerLens) => {
    setTarget((prev) => (prev ? { ...prev, lens } : prev));
  }, []);

  const toggleBrowser = useCallback(() => setFileBrowserOpen((v) => !v), []);

  /**
   * Trocar de arquivo joga fora o buffer atual. Sem esta confirmação o
   * rascunho não salvo sumia em silêncio — um clique na árvore e o texto ia
   * embora sem nada na tela dizendo que havia algo a perder.
   */
  const confirmDiscard = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm(t("folders.discardPrompt"));
  }, [t]);

  /**
   * Entrar no modo Alterações desmonta o editor, e o rascunho morre com ele —
   * a mesma perda da troca de arquivo, com a mesma confirmação.
   */
  const goToChanges = useCallback(() => {
    if (!confirmDiscard()) return false;
    dirtyRef.current = false;
    setTab("changes");
    setLeftMode("changes");
    return true;
  }, [confirmDiscard]);

  const handleTabChange = useCallback(
    (next: BrowserTab) => {
      if (next === "changes") {
        goToChanges();
        return;
      }
      // A aba de commits é só do índice: o painel da esquerda fica como estava.
      if (next === "files") setLeftMode("files");
      setTab(next);
    },
    [goToChanges],
  );

  /**
   * Trazer um arquivo à vista: o índice à direita manda o caminho ABSOLUTO —
   * com mais de um repositório é o único que não deixa dúvida de qual projeto
   * é — e a visão empilhada resolve o repo e o caminho relativo a partir dele.
   */
  const handleReveal = useCallback(
    (filePath: string) => {
      if (!goToChanges()) return;
      revealNonce.current += 1;
      setReveal({ path: filePath, nonce: revealNonce.current });
    },
    [goToChanges],
  );

  /**
   * Põe um arquivo do working tree em foco — ou o fantasma de um excluído,
   * que o visualizador abre pelo conteúdo do HEAD. Ler o arquivo é do
   * visualizador: aqui só se decide qual é, e com que lente.
   *
   * Devolve se abriu: quem precisa trocar de modo junto com a abertura só
   * deve fazê-lo depois de a confirmação passar.
   */
  const openLiveFile = useCallback(
    (filePath: string, deleted = false, lens: ViewerLens = "content") => {
      if (!confirmDiscard()) return false;
      const repo = folders[0];
      let relPath: string | null = null;
      if (repo) {
        const root = repo.replace(/[\\/]+$/, "");
        const sep = root.includes("\\") ? "\\" : "/";
        if (filePath.startsWith(root + sep))
          relPath = filePath.slice(root.length + 1).replace(/\\/g, "/");
      }
      setTarget({
        file: { kind: "live", path: filePath, relPath, deleted },
        lens,
      });
      return true;
    },
    [folders, confirmDiscard],
  );

  /**
   * Põe em foco um arquivo congelado em um commit. A leitura vai para o modo
   * Arquivos: o que se quer ver é o arquivo do commit, e ele não está no working
   * tree — na leitura de Alterações não haveria seção dele para onde rolar.
   */
  const openCommitFile = useCallback(
    (
      repoPath: string,
      hash: string,
      path: string,
      deleted: boolean,
      lens: ViewerLens = "content",
    ) => {
      if (!confirmDiscard()) return;
      setLeftMode("files");
      setTarget({
        file: { kind: "commit", repoPath, hash, path, deleted },
        lens,
      });
    },
    [confirmDiscard],
  );

  /** Do diff empilhado para o editor: é a única porta de saída da leitura. */
  const handleOpenFromDiff = useCallback(
    (absPath: string) => {
      if (!openLiveFile(absPath, false, "content")) return;
      setLeftMode("files");
      setTab("files");
    },
    [openLiveFile],
  );

  if (folders.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t("folders.empty")}</p>
        <FolderSelector folders={folders} onFoldersChange={setFolders} />
      </div>
    );
  }

  return (
    <PanelGroup className="min-h-0 min-w-0 flex-1" direction="horizontal">
      <Panel
        className="min-w-0"
        defaultSize={60}
        id="code-viewer"
        minSize={25}
        order={1}
      >
        {leftMode === "changes" ? (
          <ChangesView
            onOpenFile={handleOpenFromDiff}
            reloadToken={changesReload}
            repoRoot={folders[0]}
            repos={repos}
            reveal={reveal}
          />
        ) : (
          <FileViewer
            key={viewerKey(target?.file)}
            file={target?.file ?? null}
            lens={target?.lens ?? "content"}
            onDirtyChange={handleDirtyChange}
            onLensChange={handleLensChange}
            onToggleBrowser={toggleBrowser}
            repoRoot={folders[0]}
            roots={folders}
          />
        )}
      </Panel>
      {fileBrowserOpen && (
        <PanelResizeHandle className="group relative flex w-0.5 items-center justify-center ">
          <div className="h-8 w-1 rounded-full bg-transparent transition-colors group-hover:bg-border group-data-[resize-handle-active]:bg-border" />
        </PanelResizeHandle>
      )}
      {fileBrowserOpen && (
        <Panel
          className="min-w-0 pb-2"
          defaultSize={40}
          id="file-browser"
          minSize={15}
          order={2}
          style={{ minWidth: FILE_PANEL_MIN_PX }}
        >
          <FileBrowser
            folders={folders}
            onFoldersChange={setFolders}
            onOpenCommitFile={openCommitFile}
            onRefreshChanges={() => setChangesReload((n) => n + 1)}
            onReveal={handleReveal}
            onSelectFile={openLiveFile}
            onTabChange={handleTabChange}
            selectedPath={
              target?.file.kind === "live" ? target.file.path : undefined
            }
            tab={tab}
          />
        </Panel>
      )}
    </PanelGroup>
  );
}
