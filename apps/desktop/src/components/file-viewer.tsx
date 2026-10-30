"use client";

/**
 * The left panel of the folders tab: it shows ONE file.
 *
 * It owns the state of what it displays — content, draft, conflict, markdown
 * mode and the lens (content or diff). What comes from outside is only the file
 * reference (`file`) and the workspace context; what goes out is the notice that there is an
 * unsaved draft, which whoever switches files needs to consult beforehand.
 *
 * Before this, the same state was spread across the tab component, with
 * `viewedFile` and `diffMode`/`diffPatch` as parallel states describing the
 * same screen — switching lens meant touching three states from outside. Here the target
 * of the viewer is a single one (`file`), and the lens is an attribute of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  Ellipsis,
  EyeIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  Loader2,
  PanelRightCloseIcon,
  SaveIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import {
  CodeEditor,
  type CodeEditorHandle,
  type SearchReplaceOptions,
} from "@/src/components/code-editor";
import { FileFindBar } from "@/src/components/file-find-bar";
import { agentWriteFromTool } from "@/src/lib/agent-merge";
import { chatApi, fsApi } from "@/src/lib/ipc";
import { parsePatch } from "@/lib/unified-diff";
import { HighlightedDiffFile } from "@/src/components/diff-lines";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/src/components/ai/artifact";
import { MessageResponse } from "@/src/components/ai/message";
import {
  markdownImageSources,
  withResolvedImages,
} from "@/src/lib/markdown-images";
import { localImageRehypePlugins } from "@/src/lib/local-image-plugins";
import { Image } from "@/src/components/ai/image";
import {
  getBaseName,
  getBreadcrumbs,
  isImageFile,
  type DiffResult,
  type ReadFileResult,
  type ViewedFile,
  type ViewerLens,
} from "@/src/lib/folders";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Truncate } from "@/components/ui/truncated-text"

/** Automatic saving: a panel preference, like the others. */
const AUTO_SAVE_KEY = "orbit-files-auto-save";
/** Wait after the last key before the automatic save. */
const AUTO_SAVE_DEBOUNCE_MS = 1000;

export interface FileViewerProps {
  /** The focused file; `null` shows the invitation to pick one in the tree. */
  file: ViewedFile | null;
  /** Repo root — basis of the breadcrumbs and of the git reads. */
  repoRoot?: string;
  /** Workspace folders: allowlist of the save and eslint root. */
  roots: string[];
  /** Tells the parent that the draft came into existence or disappeared. It needs to be stable. */
  onDirtyChange: (dirty: boolean) => void;
  /** The lens over the file: the content itself or its diff. */
  lens: ViewerLens;
  /** Lens switch — the two floating buttons of the bottom right corner. */
  onLensChange: (lens: ViewerLens) => void;
  /** Toggles the visibility of the file browser (header button). */
  onToggleBrowser: () => void;
  /**
   * Hands the parent the function that replaces in the open buffer — and `null` when
   * there is no editor (diff lens, image, closed file). Going through the
   * editor, and not through the disk, is what preserves an unsaved draft.
   */
  onRegisterReplaceInFile?: (
    fn:
      | ((query: string, replacement: string, options: SearchReplaceOptions) => number)
      | null,
  ) => void;
  /** Line to scroll to as soon as the file finishes loading. */
  revealLine?: { line: number; nonce: number };
  /**
   * The query of the index search, to mark the occurrences inside the
   * open file. Empty clears it. The panel on the right stops being just a
   * list: it points in the text at what it is listing.
   */
  searchHighlight?: { query: string; options: SearchReplaceOptions } | null;
  /**
   * It grows when the file changed ON DISK from outside the editor — which is what the
   * mass replacement does. The draft rules: with a pending edit the
   * reload does not happen, so as not to erase what has not been saved yet.
   */
  reloadToken?: number;
}

/**
 * Diff mode of the viewer: it highlights with the language and only paints the background.
 */
function DiffCodeView({ patch, filePath }: { patch: string; filePath: string }) {
  const { t } = useTranslation();
  const files = useMemo(() => parsePatch(patch), [patch]);

  if (files.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("folders.noChangesInDiff")}
      </div>
    );
  }

  return (
    <div className="min-w-0 font-mono text-xs">
      {files.map((file, fi) => (
        <HighlightedDiffFile key={fi} file={file} filePath={filePath} />
      ))}
    </div>
  );
}

export function FileViewer({
  file,
  repoRoot,
  roots,
  lens,
  onDirtyChange,
  onLensChange,
  onToggleBrowser,
  onRegisterReplaceInFile,
  revealLine,
  reloadToken,
  searchHighlight,
}: FileViewerProps) {
  const { t } = useTranslation();

  const [content, setContent] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(file != null);
  /** mtime from when the file was opened — reference of the save against a
   *  concurrent write (agent, another editor). */
  const [mtime, setMtime] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Reason why the last save or the last agent write did not go through. */
  const [conflict, setConflict] = useState<
    null | { kind: "stale" } | { kind: "agent" } | { kind: "failed"; message: string }
  >(null);
  const [autoSave, setAutoSave] = useState(
    () => localStorage.getItem(AUTO_SAVE_KEY) === "true",
  );
  const [copied, setCopied] = useState(false);
  const [mdMode, setMdMode] = useState<"source" | "preview">("preview");
  /** Cmd+F: the search bar of the open file. */
  const [findOpen, setFindOpen] = useState(false);
  /** Patch of the diff lens — the only data it carries from git. */
  const [patch, setPatch] = useState<string | null>(null);
  // Opening straight in the diff (which is what the changes list asks for) is born
  // loading: without that the panel blinks empty before the patch arrives.
  const [patchLoading, setPatchLoading] = useState(
    file != null && lens === "diff",
  );
  const [patchError, setPatchError] = useState<string | null>(null);
  /** Figures of the open Markdown, resolved against ITS folder. */
  const [previewImages, setPreviewImages] = useState<Record<string, string>>({});

  const editorRef = useRef<CodeEditorHandle>(null);
  const autoSaveTimer = useRef<number>();
  const copyTimeoutRef = useRef<number>();
  /** Mirror of "there is a draft": effects that cannot depend on the state read from here. */
  const dirtyNow = useRef(false);
  dirtyNow.current = dirty;
  /** Last reload token already applied — it separates "opened another file" from
   *  "the same file changed on disk". */
  const appliedReload = useRef(reloadToken);

  /**
   * `repoRoot`, `t` and `onDirtyChange` enter by ref inside the effects: they are
   * context, not the target of the viewer. As a dependency, switching language or
   * root folder would reload the file over a draft being edited.
   */
  const repoRootRef = useRef(repoRoot);
  repoRootRef.current = repoRoot;
  const tRef = useRef(t);
  tRef.current = t;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  /** Switching file throws away everything that belonged to the previous one. */
  const resetEditorState = useCallback(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    setImage(null);
    setMtime(null);
    setDirty(false);
    setConflict(null);
    setMdMode("preview");
    setPatch(null);
    setPatchError(null);
    setPreviewImages({});
  }, []);

  // Leaving the scene (tab switch) takes the draft along — the parent cannot
  // keep thinking there is something to discard after that.
  useEffect(() => () => onDirtyChangeRef.current(false), []);

  useEffect(() => {
    if (!file) return;
    const externalReload = appliedReload.current !== reloadToken;
    appliedReload.current = reloadToken;
    // Write from outside (mass replacement) with a pending draft: the text
    // on screen wins, otherwise reloading would erase what has not been saved yet.
    if (externalReload && dirtyNow.current) return;
    let cancelled = false;
    resetEditorState();
    onDirtyChangeRef.current(false);

    const read = async () => {
      const root = repoRootRef.current;
      const tr = tRef.current;

      if (file.kind === "commit") {
        if (isImageFile(file.path)) {
          if (cancelled) return;
          setLoading(false);
          setError(tr("folders.imageNotAvailable"));
          return;
        }
        const result = (await window.ipcRenderer.invoke(
          "git:showFile",
          file.repoPath,
          file.hash,
          file.path,
          file.deleted,
        )) as ReadFileResult;
        if (cancelled) return;
        setLoading(false);
        if ("content" in result) setContent(result.content);
        else setError(result.error);
        return;
      }

      if (isImageFile(file.path)) {
        if (file.deleted) {
          if (cancelled) return;
          setLoading(false);
          setError(tr("folders.imageNotAvailable"));
          return;
        }
        const result = (await window.ipcRenderer.invoke(
          "fs:readFileAsDataUrl",
          file.path,
        )) as { dataUrl: string } | { error: string };
        if (cancelled) return;
        setLoading(false);
        if ("dataUrl" in result) setImage(result.dataUrl);
        else setError(result.error);
        return;
      }

      if (file.deleted) {
        // File deleted in the working tree: the default mode shows the content
        // at HEAD (the file does not exist on disk anymore).
        if (root && file.relPath) {
          const result = (await window.ipcRenderer.invoke(
            "git:showFile",
            root,
            "HEAD",
            file.relPath,
            false,
          )) as ReadFileResult;
          if (cancelled) return;
          setLoading(false);
          if ("content" in result) setContent(result.content);
          else setError(result.error);
        } else {
          setLoading(false);
          setError(tr("folders.diffUnavailable"));
        }
        return;
      }

      const result = (await window.ipcRenderer.invoke(
        "fs:readFile",
        file.path,
      )) as ReadFileResult;
      if (cancelled) return;
      setLoading(false);
      if ("content" in result) {
        setContent(result.content);
        setMtime(result.mtimeMs ?? null);
      } else setError(result.error);
    };

    void read();
    return () => {
      cancelled = true;
    };
  }, [file, resetEditorState, reloadToken]);

  /**
   * Scrolls to the line asked for by the index search. It waits for the content: with the
   * editor still empty the document has no line to go to.
   */
  useEffect(() => {
    if (!revealLine || content == null) return;
    editorRef.current?.scrollToLine(revealLine.line);
  }, [revealLine, content]);

  // Switching file closes the bar: one's query does not count in the other, and
  // leaving it open with "0/0" would look like a file without the searched word.
  useEffect(() => {
    setFindOpen(false);
  }, [file?.path]);

  /**
   * The search mark follows the query, and needs to be re-applied when the
   * content arrives — the editor is born empty on every file, and a mark applied
   * before that would have no text to fall on.
   */
  useEffect(() => {
    if (content == null) return;
    editorRef.current?.highlightQuery(
      searchHighlight?.query ?? "",
      searchHighlight?.options,
    );
  }, [searchHighlight, content]);

  const isMarkdownFile = file ? /(?:\.md|\.markdown)$/i.test(file.path) : false;
  const isImage = file ? isImageFile(file.path) : false;

  /**
   * Figures of the open Markdown, resolved against ITS folder.
   *
   * The preview runs on the app origin, so a `./images/x.png` does not resolve
   * against the file and the image appeared broken. The one that knows the folder is the main process,
   * which returns each path as a data URL.
   */
  useEffect(() => {
    if (!content || !file || !isMarkdownFile || mdMode !== "preview") {
      setPreviewImages({});
      return;
    }
    const sources = markdownImageSources(content);
    if (sources.length === 0) {
      setPreviewImages({});
      return;
    }
    // In the commit file the path is relative to the repository; joining with "/"
    // is enough, because the main process resolves it with path.resolve.
    const base =
      file.kind === "live" ? file.path : `${file.repoPath}/${file.path}`;
    let cancelled = false;
    window.ipcRenderer
      .invoke("fs:markdownImages", base, sources)
      .then((map) => {
        if (!cancelled) setPreviewImages(map as Record<string, string>);
      })
      .catch(() => {
        // a figure is decoration: failing here cannot take down the reading of the text
      });
    return () => {
      cancelled = true;
    };
  }, [content, file, isMarkdownFile, mdMode]);

  const previewMarkdown = useMemo(
    () => (content ? withResolvedImages(content, previewImages) : ""),
    [content, previewImages],
  );

  /** The branch that renders the CodeEditor — the one that scrolls is it, not the parent. */
  const showsEditor =
    !loading &&
    lens === "content" &&
    !error &&
    image == null &&
    content != null &&
    !(isMarkdownFile && mdMode === "preview");

  /**
   * ⌘F with the focus OUTSIDE the editor — in the tree, right after opening the file —
   * does not reach the CodeMirror keymap, and that is exactly where the key is
   * pressed. Here it is captured on the window; with the focus in the editor, its
   * keymap has already marked `defaultPrevented` and this handler keeps quiet.
   */
  useEffect(() => {
    function onFind(event: KeyboardEvent) {
      if (event.defaultPrevented || !showsEditor) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return;
      if (event.code !== "KeyF") return;
      // A text field outside the editor (composer, panel search) rules over itself.
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable='true']") &&
        !target.closest(".cm-editor")
      ) {
        return;
      }
      event.preventDefault();
      setFindOpen(true);
    }
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [showsEditor]);

  /**
   * Only a working tree file is editable: the one of a commit is history, and the
   * deleted one does not exist on disk anymore.
   */
  const canEdit =
    file?.kind === "live" &&
    !file.deleted &&
    !isImage &&
    lens === "content" &&
    roots.length > 0;

  const saveFile = useCallback(
    async (next: string) => {
      if (!file || file.kind !== "live") return;
      setSaving(true);
      const result = await fsApi.writeFile({
        filePath: file.path,
        content: next,
        roots,
        expectedMtimeMs: mtime ?? undefined,
      });
      setSaving(false);
      if (result.ok) {
        setConflict(null);
        setMtime(result.mtimeMs);
        // It becomes the new basis of the editor: the buffer starts mirroring the disk and the
        // draft indicator goes off.
        setContent(next);
        return;
      }
      if (result.reason === "stale") {
        // Someone wrote in the middle. It overwrites nothing: it shows the notice and
        // lets the person choose between reloading and insisting.
        setConflict({ kind: "stale" });
        return;
      }
      setConflict({
        kind: "failed",
        message: t(`folders.saveError.${result.reason}`, {
          defaultValue:
            "error" in result ? (result.error ?? result.reason) : result.reason,
        }),
      });
    },
    [file, roots, mtime, t],
  );

  /** Discards the draft and brings what is on disk. */
  const reloadFromDisk = useCallback(async () => {
    if (!file || file.kind !== "live") return;
    const result = (await window.ipcRenderer.invoke(
      "fs:readFile",
      file.path,
    )) as ReadFileResult;
    if ("content" in result) {
      setContent(result.content);
      setMtime(result.mtimeMs ?? null);
      setConflict(null);
    }
  }, [file]);

  /** Writes over it, accepting the loss of what changed on disk. */
  const overwrite = useCallback(async () => {
    const next = editorRef.current?.getContent();
    if (next == null || !file || file.kind !== "live") return;
    setSaving(true);
    const result = await fsApi.writeFile({
      filePath: file.path,
      content: next,
      roots,
    });
    setSaving(false);
    if (result.ok) {
      setConflict(null);
      setMtime(result.mtimeMs);
      setContent(next);
    }
  }, [file, roots]);

  /** Re-reads only the mtime, without touching the buffer — the content has already been merged. */
  const reloadMtime = useCallback(async (filePath: string) => {
    const result = (await window.ipcRenderer.invoke(
      "fs:readFile",
      filePath,
    )) as ReadFileResult;
    if ("content" in result) setMtime(result.mtimeMs ?? null);
  }, []);

  /**
   * Agent write in the open file.
   *
   * The chat `part` event already brings the tool input, so it is possible to merge the
   * change into the buffer instead of reloading over it — cursor, selection,
   * scroll, undo and the draft in other parts of the file survive.
   *
   * `bash` is a known blind spot: it writes a file and does not say which. For those
   * cases what protects is the mtime check on save.
   */
  useEffect(() => {
    const current = file;
    if (!current || current.kind !== "live") return;
    const open = current.path.replace(/\\/g, "/");
    return chatApi.onEvent((event) => {
      if (event.type !== "part" || event.part.type !== "tool") return;
      // Only after written: 'running' has not written to disk yet, and merging
      // there would leave the buffer ahead of the file.
      if (event.part.state !== "done") return;
      const parsed = agentWriteFromTool(event.part.tool, event.part.input);
      if (!parsed) return;
      // The tool path may come relative to the working folder.
      const target = parsed.filePath.replace(/\\/g, "/");
      if (open !== target && !open.endsWith(`/${target}`)) return;
      const outcome = editorRef.current?.applyAgentWrite(parsed.write);
      if (!outcome) return;
      if (outcome.kind === "conflict") {
        setConflict({ kind: "agent" });
        return;
      }
      // The disk changed: without renewing the mtime, the next save would be refused as
      // outdated even though the agent change had already been incorporated.
      void reloadMtime(current.path);
      if (outcome.wasClean) setContent(outcome.content);
    });
  }, [file, reloadMtime]);

  /**
   * The editor draft goes up to whoever switches files.
   *
   * The `dirty` notice is the viewer's (it is what shows the dot next to the
   * path), but the one that decides whether the buffer can be thrown away is the tab. Without this
   * bridge, the file switch would discard the text without asking anything.
   */
  const handleEditorDirty = useCallback(
    (next: boolean) => {
      setDirty(next);
      onDirtyChange(next);
    },
    [onDirtyChange],
  );

  /** Typing in the editor — it only serves the automatic saving. */
  const handleEditorChange = useCallback(
    (next: string) => {
      window.clearTimeout(autoSaveTimer.current);
      if (!autoSave || !canEdit) return;
      autoSaveTimer.current = window.setTimeout(() => {
        void saveFile(next);
      }, AUTO_SAVE_DEBOUNCE_MS);
    },
    [autoSave, canEdit, saveFile],
  );

  // Switching file with an automatic save pending would write the text of one
  // file inside the other.
  useEffect(() => {
    return () => window.clearTimeout(autoSaveTimer.current);
  }, [file]);

  const toggleAutoSave = useCallback(() => {
    setAutoSave((prev) => {
      const next = !prev;
      localStorage.setItem(AUTO_SAVE_KEY, String(next));
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleCopyPath = useCallback(async () => {
    if (!file) return;
    await navigator.clipboard.writeText(file.path);
  }, [file]);

  const handleReveal = useCallback(() => {
    if (file?.kind !== "live") return;
    window.ipcRenderer
      .invoke("shell:showItemInFolder", file.path)
      .catch(console.error);
  }, [file]);

  /**
   * Fetches the patch of the diff lens, according to the origin — working tree against
   * HEAD, or the file inside a commit.
   */
  const loadPatch = useCallback(async (target: ViewedFile) => {
    const tr = tRef.current;
    const root = repoRootRef.current;
    setPatchLoading(true);
    setPatchError(null);
    try {
      const result: DiffResult =
        target.kind === "live"
          ? target.relPath && root
            ? ((await window.ipcRenderer.invoke(
                "git:diffWorkingFile",
                root,
                target.relPath,
              )) as DiffResult)
            : { ok: false, error: tr("folders.diffUnavailable") }
          : ((await window.ipcRenderer.invoke(
              "git:showCommitDiff",
              target.repoPath,
              target.hash,
              target.path,
            )) as DiffResult);
      if (result.ok) setPatch(result.patch);
      else setPatchError(result.error);
    } finally {
      setPatchLoading(false);
    }
  }, []);

  /**
   * The patch follows the lens: entering the diff loads it, going back to the content
   * discards it. That way the next entry fetches again, instead of showing a diff
   * that may have gone stale since the last time.
   */
  useEffect(() => {
    if (!file) return;
    if (lens === "content") {
      setPatch(null);
      setPatchError(null);
      return;
    }
    void loadPatch(file);
  }, [file, lens, loadPatch]);

  /**
   * Lens switch. The choice is the parent's — it is what decides with what lens a
   * file opens —, so here it is only kept while the file or the patch loads.
   */
  const selectLens = useCallback(
    (next: ViewerLens) => {
      if (!file || loading || patchLoading) return;
      onLensChange(next);
    },
    [file, loading, patchLoading, onLensChange],
  );

  useEffect(() => () => window.clearTimeout(copyTimeoutRef.current), []);

  /**
   * Publishes the replacement in the buffer for whoever is outside: the search of the right
   * panel swaps the text without touching the disk. Without an editor (diff lens,
   * image, no file) the registry becomes `null` and the UI disables the button.
   */
  useEffect(() => {
    if (!onRegisterReplaceInFile) return;
    onRegisterReplaceInFile((query, replacement, options) =>
      editorRef.current?.replaceAll(query, replacement, options) ?? 0,
    );
    return () => onRegisterReplaceInFile(null);
  }, [onRegisterReplaceInFile]);

  return (
    <Artifact className="h-full min-w-0 rounded-none border-0 bg-sidebar mt-2">
      <ArtifactHeader className="min-w-0 bg-sidebar">
        <div className="min-w-0">
          {file ? (
            <>
              {file.kind === "commit" && (
                <ArtifactTitle className="flex items-center gap-1.5 truncate">
                  <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  {file.hash.slice(0, 7)}
                </ArtifactTitle>
              )}
              <ArtifactDescription className="flex min-w-0 items-center gap-1.5">
                
                  <Truncate>
                      <span className="truncate">
                      {getBreadcrumbs(repoRoot ?? "", file.path).map((part, i, arr) => (
                        <span key={i}>
                          {i > 0 && (
                            <span className="mx-0.5 text-muted-foreground/50">›</span>
                        )}
                        <span
                          className={cn(
                            i === arr.length - 1 && "font-medium text-foreground",
                          )}
                        >
                          {part}
                        </span>
                      </span>
                    ))}
                  </span>
                  </Truncate>
                {dirty && (
                  <span
                    title={t("folders.unsaved")}
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                  />
                )}
                {saving && (
                  <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                )}
              </ArtifactDescription>
            </>
          ) : (
            <ArtifactTitle className="flex items-center gap-1.5 truncate">
              <FolderTreeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              {t("folders.explorer")}
            </ArtifactTitle>
          )}
        </div>
        <ArtifactActions>
          <ArtifactAction
            icon={PanelRightCloseIcon}
            onClick={onToggleBrowser}
          />
          {file && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
                <Ellipsis className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem onClick={handleCopyPath}>
                  <CopyIcon className="size-4" />
                  {t("folders.copyPath")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleCopy} disabled={isImage}>
                  {copied ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                  {t("folders.copyContent")}
                </DropdownMenuItem>
                {canEdit && (
                  <DropdownMenuItem onClick={toggleAutoSave}>
                    {autoSave ? (
                      <CheckIcon className="size-4" />
                    ) : (
                      <SaveIcon className="size-4" />
                    )}
                    {t("folders.autoSave")}
                  </DropdownMenuItem>
                )}
                {file.kind === "live" && (
                  <DropdownMenuItem onClick={handleReveal}>
                    <FolderOpenIcon className="size-4" />
                    {t("folders.reveal")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ArtifactActions>
      </ArtifactHeader>
      {file ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex flex-col items-end gap-1.5 [&>*]:pointer-events-auto">
            {!isImage && (
              <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
                <Hint label={t("folders.standardMode")}>
                  <button
                    type="button"
                    onClick={() => selectLens("content")}

                    className={cn(
                      "flex size-6 items-center justify-center rounded-full transition-colors",
                      lens === "content"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <FileTextIcon className="size-3.5" />
                  </button>
                </Hint>
                <Hint label={t("folders.diffMode")}>
                  <button
                    type="button"
                    onClick={() => selectLens("diff")}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full transition-colors",
                      lens === "diff"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
       
                           {patchLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <GitCompareArrowsIcon className="size-3.5" />
                  )}
                </button>
                </Hint>
              </div>
            )}
            {isMarkdownFile && lens === "content" && (
              <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
                <Hint label={t("folders.sourceMode")}>
                  <button
                    type="button"
                    onClick={() => setMdMode("source")}

                    className={cn(
                      "flex size-6 items-center justify-center rounded-full transition-colors",
                      mdMode === "source"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <CodeIcon className="size-3.5" />
                  </button>
                </Hint>
                <Hint label={t("folders.previewMode")}>
                  <button
                    type="button"
                    onClick={() => setMdMode("preview")}

                    className={cn(
                      "flex size-6 items-center justify-center rounded-full transition-colors",
                      mdMode === "preview"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <EyeIcon className="size-3.5" />
                  </button>
                </Hint>
              </div>
            )}
          </div>
          {conflict && (
            <div className="z-20 flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
              <span className="flex-1 min-w-40">
                {conflict.kind === "stale"
                  ? t("folders.conflictStale")
                  : conflict.kind === "agent"
                    ? t("folders.conflictAgent")
                    : conflict.message}
              </span>
              {conflict.kind !== "failed" && (
                <>
                  <button
                    type="button"
                    onClick={() => void reloadFromDisk()}
                    className="rounded-md px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                  >
                    {t("folders.conflictReload")}
                  </button>
                  {conflict.kind === "stale" && (
                    <button
                      type="button"
                      onClick={() => void overwrite()}
                      className="rounded-md px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                    >
                      {t("folders.conflictOverwrite")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConflict(null)}
                    className="rounded-md px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                  >
                    {t("folders.conflictKeepMine")}
                  </button>
                </>
              )}
            </div>
          )}
          {/* The bar stays OUTSIDE the scroller: the editor scrolls inside it, and
              a search that scrolls along with the code leaves the screen right when
              you are searching. */}
          {findOpen && showsEditor && (
            <FileFindBar editor={editorRef} onClose={() => setFindOpen(false)} />
          )}
          <ArtifactContent
            className={cn(
              "min-h-0 min-w-0 flex-1 p-0",
              // The editor scrolls inside (and only materializes the
              // visible lines); the other modes keep scrolling in the parent.
              showsEditor ? "overflow-hidden" : "overflow-auto",
            )}
          >
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : lens === "diff" ? (
              patchLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {t("common.loading")}
                </div>
              ) : patchError ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {patchError}
                </div>
              ) : patch != null ? (
                <DiffCodeView patch={patch} filePath={file.path} />
              ) : null
            ) : error ? (
              <div className="p-4 text-sm text-muted-foreground">{error}</div>
            ) : image != null ? (
              <div className="flex min-w-0 items-start justify-center p-4">
                <Image src={image} alt={getBaseName(file.path)} />
              </div>
            ) : content != null ? (
              isMarkdownFile && mdMode === "preview" ? (
                <div className="min-w-0 px-4 py-4 text-sm text-foreground">
                  {/* The default pipeline discards `src` in data URL, which is
                      what the local figure becomes after being resolved. */}
                  <MessageResponse rehypePlugins={localImageRehypePlugins}>
                    {previewMarkdown}
                  </MessageResponse>
                </div>
              ) : (
                <CodeEditor
                  ref={editorRef}
                  content={content}
                  filePath={file.path}
                  wrap={isMarkdownFile}
                  editable={canEdit}
                  workspaceRoot={repoRoot}
                  onSave={saveFile}
                  onDirtyChange={handleEditorDirty}
                  onChange={handleEditorChange}
                  onRequestFind={() => setFindOpen(true)}
                />
              )
            ) : null}
          </ArtifactContent>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <FolderTreeIcon className="size-16 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground">
            {t("folders.selectFileHint")}
          </p>
        </div>
      )}
    </Artifact>
  );
}
