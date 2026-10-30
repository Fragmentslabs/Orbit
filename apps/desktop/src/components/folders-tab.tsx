"use client";

/**
 * The folders tab: the reading panel on the left, the index on the right.
 *
 * The index on the right has three tabs — Files, Changes and Commits — and the left
 * panel has two modes, chosen by the first two:
 *
 * - **Files** — the full tree on the right, a single file on the left. It is the
 *   working mode: look up, open, edit.
 * - **Changes** — the list of the modified ones on the right, all the diffs
 *   stacked on the left. It is the reading mode: comparing what changed without
 *   losing sight of what has already been read. Here clicking a file does not swap what
 *   is on screen — it only scrolls to its section.
 * - **Commits** — the history, which belongs only to the index: the left stays as it was,
 *   and the file of a commit opens in it when one clicks it.
 *
 * Here lives only what belongs to the set: which mode is active, which file is in
 * focus, with what lens it opens, how far to scroll and whether there is a draft to lose.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "@/lib/workspace-context";
import { FolderSelector } from "@/src/components/folder-selector";
import { FileViewer } from "@/src/components/file-viewer";
import { FileBrowser, type BrowserTab } from "@/src/components/file-browser";
import { ChangesView, type RevealRequest } from "@/src/components/changes-view";
import type { ViewedFile, ViewerLens } from "@/src/lib/folders";
import { useGitRepos } from "@/src/lib/use-git-repos";
import type { WsMatchOptions } from "@/src/lib/ipc";
import { useWorkspaceSearchStore } from "@/src/stores/workspace-search-store";

const FILE_PANEL_MIN_PX = 200;

/**
 * What is in focus: the file AND the lens over it.
 *
 * The two go together because they describe the same screen — the file alone does not
 * say whether the panel shows its text or its diff. Whoever chooses the lens is whoever
 * opens it: the changes list opens in the diff, the full tree in the content.
 */
interface ViewerTarget {
  file: ViewedFile;
  lens: ViewerLens;
}

/**
 * Identity of the file open in the viewer.
 *
 * The key exists so the viewer is reborn when switching files: its internal
 * state (draft, conflict, patch) all belongs to the previous file. It is
 * derived from the file, and not a counter, so that reopening the SAME file does not
 * throw away what is on screen — the lens stays out on purpose: switching
 * lens belongs to the viewer, and remounting it would lose the draft.
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
  // What has git in the chat folders — the main one and the attached ones —, in each one
  // the root and/or the subfolders with their own repo. The changes reading uses the
  // list to show the whole workspace, with each project under its name;
  // before, only the main folder was read and the attached ones were left out.
  const repos = useGitRepos(folders);

  const [tab, setTab] = useState<BrowserTab>("files");
  /**
   * The mode of the left panel. It is NOT the index tab: the commits tab belongs
   * only to the index, and the stacked diffs (or the open file) have no reason to
   * disappear because one went to look at the history.
   */
  const [leftMode, setLeftMode] = useState<"files" | "changes">("files");
  const [target, setTarget] = useState<ViewerTarget>();
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [changesReload, setChangesReload] = useState(0);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(true);
  /** Mirror of "there is a draft" for reading inside the switch callbacks. */
  const dirtyRef = useRef(false);
  /** Mirror of the focused target, for callbacks that cannot depend on the state. */
  const targetRef = useRef<ViewerTarget | undefined>(undefined);
  targetRef.current = target;
  /** Grows on every focus request: repeating the click on the same file counts again. */
  const revealNonce = useRef(0);
  /** Line asked for by the search; the viewer scrolls to it when loading the file. */
  const [revealLine, setRevealLine] = useState<{ line: number; nonce: number }>();
  const lineNonce = useRef(0);
  /** Grows when a mass replacement writes the file that is open. */
  const [viewerReload, setViewerReload] = useState(0);

  /**
   * The replacement in the open file lives in the editor (it is what has the buffer and
   * the undo history). The viewer publishes the function here, and the search of the
   * index on the right calls it — without going through the disk, without losing the draft.
   */
  const replaceInOpenFile = useRef<
    ((query: string, replacement: string, options: WsMatchOptions) => number) | null
  >(null);

  const registerReplaceInFile = useCallback(
    (
      fn:
        | ((query: string, replacement: string, options: WsMatchOptions) => number)
        | null,
    ) => {
      replaceInOpenFile.current = fn;
    },
    [],
  );

  const registerReplaceInOpenFile = useWorkspaceSearchStore(
    (state) => state.registerReplaceInOpenFile,
  );

  /**
   * Publishes to the App — where the ⌘P palette lives now — which file is in focus
   * and how to replace in its buffer. Without this bridge, the "Replace in this
   * file" of the modal would have no one to ask: the buffer only exists here.
   */
  useEffect(() => {
    const file = target?.file;
    if (!file || file.kind !== "live") {
      registerReplaceInOpenFile(null);
      return;
    }
    registerReplaceInOpenFile({
      path: file.path,
      run: (query, replacement, options) =>
        replaceInOpenFile.current?.(query, replacement, options) ?? 0,
    });
    return () => registerReplaceInOpenFile(null);
  }, [target, registerReplaceInOpenFile]);

  /**
   * The index query becomes a mark in the open file. It stays in the state of the tab
   * because the two sides of the split are siblings: the field lives in the tree, the
   * editor lives in the viewer, and neither sees the other without passing through here.
   */
  const [searchHighlight, setSearchHighlight] = useState<{
    query: string;
    options: WsMatchOptions;
  } | null>(null);

  const handleHighlightQuery = useCallback(
    (query: string, options: WsMatchOptions) => {
      setSearchHighlight(query === "" ? null : { query, options });
    },
    [],
  );

  const handleDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next;
  }, []);

  const handleLensChange = useCallback((lens: ViewerLens) => {
    setTarget((prev) => (prev ? { ...prev, lens } : prev));
  }, []);

  const toggleBrowser = useCallback(() => setFileBrowserOpen((v) => !v), []);

  /**
   * Switching file throws away the current buffer. Without this confirmation the
   * unsaved draft disappeared in silence — one click in the tree and the text was
   * gone with nothing on screen saying there was something to lose.
   */
  const confirmDiscard = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm(t("folders.discardPrompt"));
  }, [t]);

  /**
   * Entering Changes mode unmounts the editor, and the draft dies with it —
   * the same loss as the file switch, with the same confirmation.
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
      // The commits tab belongs only to the index: the left panel stays as it was.
      if (next === "files") setLeftMode("files");
      setTab(next);
    },
    [goToChanges],
  );

  /**
   * Bring a file into view: the index on the right sends the ABSOLUTE path —
   * with more than one repository it is the only one that leaves no doubt about which project
   * it is — and the stacked view resolves the repo and the relative path from it.
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
   * Puts a working tree file in focus — or the ghost of a deleted one,
   * which the viewer opens through the HEAD content. Reading the file belongs to the
   * viewer: here one only decides which one it is, and with what lens.
   *
   * Returns whether it opened: whoever needs to switch mode along with the opening should only
   * do it after the confirmation passes.
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
   * Puts in focus a file frozen in a commit. The reading goes to Files
   * mode: what one wants to see is the commit's file, and it is not in the working
   * tree — in the Changes reading there would be no section of it to scroll to.
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

  /** From the stacked diff to the editor: it is the only exit door of the reading. */
  const handleOpenFromDiff = useCallback(
    (absPath: string) => {
      if (!openLiveFile(absPath, false, "content")) return;
      setLeftMode("files");
      setTab("files");
    },
    [openLiveFile],
  );

  /**
   * Open a search result already on the clicked line. The discard confirmation
   * comes from `openLiveFile` — the same as any file switch — and the mode
   * goes back to Files: in the stacked reading there is nowhere to scroll inside a
   * single file.
   */
  const openAtLine = useCallback(
    (filePath: string, line?: number) => {
      if (!openLiveFile(filePath, false, "content")) return;
      setLeftMode("files");
      setTab("files");
      // A result of the Files group has no line: it opens at the top, like the
      // tree. Only the occurrence asks for a scroll.
      if (line != null) {
        lineNonce.current += 1;
        setRevealLine({ line, nonce: lineNonce.current });
      }
    },
    [openLiveFile],
  );

  /**
   * Someone wrote to disk from outside (replace in all). If it was the focused
   * file, the viewer re-reads it — otherwise the screen would show the old text
   * and the next save would overwrite the replacement.
   */
  const handleReplaced = useCallback((paths: string[]) => {
    const current = targetRef.current;
    if (current?.file.kind === "live" && paths.includes(current.file.path)) {
      setViewerReload((n) => n + 1);
    }
  }, []);

  /**
   * ⌘P went up to the App (the palette answers from any tab), so the request
   * arrives through the store. Here the part only this tab knows how to do is served: opening
   * the file in the viewer and scrolling to the requested line.
   */
  const pendingFile = useWorkspaceSearchStore((state) => state.pending);
  const handledFileRequest = useRef(0);

  useEffect(() => {
    if (!pendingFile || handledFileRequest.current === pendingFile.nonce) return;
    handledFileRequest.current = pendingFile.nonce;
    openAtLine(pendingFile.path, pendingFile.line);
  }, [pendingFile, openAtLine]);

  /** "Replace in all" may have written the open file: the store warns. */
  const replacedFiles = useWorkspaceSearchStore((state) => state.replaced);
  const handledReplaced = useRef(0);

  useEffect(() => {
    if (!replacedFiles || handledReplaced.current === replacedFiles.nonce) return;
    handledReplaced.current = replacedFiles.nonce;
    handleReplaced(replacedFiles.paths);
  }, [replacedFiles, handleReplaced]);

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
            mode={tab === "commits" ? "commits" : "changes"}
            onOpenFile={handleOpenFromDiff}
            onToggleBrowser={toggleBrowser}
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
            onRegisterReplaceInFile={registerReplaceInFile}
            onToggleBrowser={toggleBrowser}
            reloadToken={viewerReload}
            revealLine={revealLine}
            searchHighlight={searchHighlight}
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
            onOpenOccurrence={openAtLine}
            onHighlightQuery={handleHighlightQuery}
            onReplaced={handleReplaced}
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
