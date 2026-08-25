import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  ChevronUpIcon,
  CloudIcon,
  CopyIcon,
  DownloadIcon,
  Ellipsis,
  EyeIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitBranchIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  HistoryIcon,
  FolderIcon,
  PanelRightCloseIcon,
  PenLineIcon,
  TagIcon,
  UploadIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-context";
import { useTheme } from "@/components/theme-provider";
import { highlightLines, type HighlightedToken } from "@/lib/code-highlighter";
import { FolderSelector } from "@/src/components/folder-selector";
import { useBranchStore, type BranchSyncInfo, type SyncResult } from "@/src/stores/branch-store";
import { CreateRemoteRepoDialog } from "@/src/components/create-remote-repo-dialog";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/src/components/ai/file-tree";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/src/components/ai/artifact";
import {
  Commit,
  CommitContent,
  CommitFile,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFiles,
  CommitFileStatus,
  CommitHash,
  CommitHeader,
  CommitInfo,
  CommitMessage,
  CommitMetadata,
  CommitSeparator,
  CommitTimestamp,
} from "@/src/components/ai/commit";
import { MessageResponse } from "@/src/components/ai/message";
import { Image } from "@/src/components/ai/image";

interface DirEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface CommitFileEntry {
  status: "added" | "modified" | "deleted" | "renamed";
  path: string;
}

interface CommitEntry {
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

type ReaddirResult =
  | { ok: true; entries: DirEntryInfo[] }
  | { ok: false; error: string };
type ReadFileResult = { content: string } | { error: string };
type GitLogResult =
  | { ok: true; commits: CommitEntry[] }
  | { ok: false; error: string };

type ViewedFile =
  | { kind: "live"; path: string }
  | {
      kind: "commit";
      repoPath: string;
      hash: string;
      path: string;
      deleted: boolean;
    };

const FILE_PANEL_MIN_PX = 200;

function getBaseName(p: string) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

function isImageFile(p: string) {
  return IMAGE_FILE_RE.test(p);
}

function getBreadcrumbs(rootPath: string, filePath: string): string[] {
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const file = filePath.replace(/\\/g, "/");
  if (!file.startsWith(root)) return [];
  const relative = file.slice(root.length + 1);
  const parts = relative.split("/");
  return [getBaseName(rootPath), ...parts];
}

// ── Regiões do log de commits (estilo VS Code) ──────────────────────────
type CommitRegionKind = "default" | "pushed" | "local";

interface CommitRegion {
  kind: CommitRegionKind;
  label: string;
}

interface CommitRow {
  divider?: CommitRegion;
  commit?: CommitEntry;
}

const REGION_STYLES: Record<CommitRegionKind, { line: string; chip: string }> = {
  local: {
    line: "bg-amber-500/40",
    chip: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  pushed: {
    line: "bg-emerald-500/40",
    chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  default: {
    line: "bg-border",
    chip: "border-border bg-muted text-muted-foreground",
  },
};

/** Região de um commit: branch principal, branch atual já no remoto, ou branch atual só local. */
function commitRegion(commit: CommitEntry, info: BranchSyncInfo | undefined): CommitRegion | null {
  if (!info?.current) return null;
  if (info.defaultBranch && info.defaultBranch !== info.current) {
    if (commit.onDefault) return { kind: "default", label: info.defaultBranch };
    return commit.pushed
      ? { kind: "pushed", label: info.upstream ?? info.current }
      : { kind: "local", label: info.current };
  }
  return commit.pushed
    ? { kind: "pushed", label: info.upstream ?? info.current }
    : { kind: "local", label: info.current };
}

// ── Badges de refs nos cards ────────────────────────────────────────────
type RefKind = "current" | "default" | "remote" | "tag" | "head" | "other";

function classifyRef(
  ref: string,
  current: string | null | undefined,
  defaultBranch: string | null | undefined,
): { kind: RefKind; name: string } {
  if (ref.startsWith("refs/heads/")) {
    const name = ref.slice("refs/heads/".length);
    if (name === current) return { kind: "current", name };
    if (name === defaultBranch) return { kind: "default", name };
    return { kind: "head", name };
  }
  if (ref.startsWith("refs/remotes/")) {
    return { kind: "remote", name: ref.slice("refs/remotes/".length) };
  }
  if (ref.startsWith("refs/tags/")) {
    return { kind: "tag", name: ref.slice("refs/tags/".length) };
  }
  return { kind: "other", name: ref };
}

const REF_BADGE_STYLES: Record<RefKind, string> = {
  current: "border-primary/30 bg-primary/10 text-primary",
  default: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  remote: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  tag: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  head: "border-border bg-muted text-muted-foreground",
  other: "border-border bg-muted text-muted-foreground",
};

const REF_PRIORITY: Record<RefKind, number> = {
  current: 0,
  default: 1,
  remote: 2,
  tag: 3,
  head: 4,
  other: 5,
};

const MAX_BRANCH_BADGES = 3;
const MAX_TAG_BADGES = 2;

function RefBadge({ kind, name }: { kind: RefKind; name: string }) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex max-w-32 items-center gap-1 truncate rounded-full border px-1.5 py-px text-[9px] font-medium",
        REF_BADGE_STYLES[kind],
      )}
    >
      {kind === "tag" && <TagIcon className="size-2.5 shrink-0" />}
      {kind === "remote" && <CloudIcon className="size-2.5 shrink-0" />}
      {kind === "current" && <GitBranchIcon className="size-2.5 shrink-0" />}
      <span className="truncate">{name}</span>
    </span>
  );
}

function CommitRefBadges({
  refs,
  current,
  defaultBranch,
}: {
  refs: string[];
  current?: string | null;
  defaultBranch?: string | null;
}) {
  if (!refs.length) return null;
  const classified = refs.map((ref) => classifyRef(ref, current, defaultBranch));
  // Branches e tags em grupos independentes: tags sempre aparecem ao lado
  // das branches, sem serem descartadas pelo limite de badges de branch.
  const branches = classified
    .filter((b) => b.kind !== "tag")
    .sort((a, b) => REF_PRIORITY[a.kind] - REF_PRIORITY[b.kind]);
  const tags = classified
    .filter((b) => b.kind === "tag")
    .sort((a, b) => a.name.localeCompare(b.name));
  const visibleBranches = branches.slice(0, MAX_BRANCH_BADGES);
  const visibleTags = tags.slice(0, MAX_TAG_BADGES);
  const rest = [
    ...branches.slice(MAX_BRANCH_BADGES),
    ...tags.slice(MAX_TAG_BADGES),
  ];
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5">
      {visibleBranches.map((b) => (
        <RefBadge key={b.name} kind={b.kind} name={b.name} />
      ))}
      {visibleTags.map((b) => (
        <RefBadge key={b.name} kind={b.kind} name={b.name} />
      ))}
      {rest.length > 0 && (
        <span
          title={rest.map((b) => b.name).join(", ")}
          className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

function renderEntries(
  entries: DirEntryInfo[] | undefined,
  dirCache: Record<string, DirEntryInfo[]>,
  expandedPaths: Set<string>,
) {
  if (!entries) return null;
  return entries.map((entry) =>
    entry.isDirectory ? (
      <FileTreeFolder key={entry.path} name={entry.name} path={entry.path}>
        {expandedPaths.has(entry.path) &&
          renderEntries(dirCache[entry.path], dirCache, expandedPaths)}
      </FileTreeFolder>
    ) : (
      <FileTreeFile key={entry.path} name={entry.name} path={entry.path} />
    ),
  );
}

function FolderQuickSwitch({
  folders,
  onFoldersChange,
}: {
  folders: string[];
  onFoldersChange: (f: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const primaryName =
    folders.length === 0 ? t("folders.noFolder") : getBaseName(folders[0]);

  const handleSelectFolder = (path: string) => {
    setOpen(false);
    if (folders[0] === path) return;
    onFoldersChange([path, ...folders.filter((f) => f !== path)]);
  };

  return (
    <div
      className="relative shrink-0 border-t border-sidebar-border p-2 pt-2.5"
      ref={ref}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">{primaryName}</span>
        <ChevronUpIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("folders.associated")}
          </p>
          {folders.map((f) => (
            <button
              key={f}
              onClick={() => handleSelectFolder(f)}
              className="flex w-full min-h-7 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-left">
                {getBaseName(f)}
              </span>
              {folders[0] === f && <CheckIcon className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CodeView({
  content,
  highlighted,
}: {
  content: string;
  highlighted: HighlightedToken[][] | null;
}) {
  const lines = content.split("\n");
  return (
    <div className="flex min-w-0 font-mono text-xs">
      <div className="sticky left-0 z-10 min-w-0 shrink-0 select-none bg-code-viewer px-3 py-4 text-right text-muted-foreground/50">
        {lines.map((_, i) => (
          <div key={i} className="leading-5">
            {i + 1}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 px-4 py-4">
        {highlighted
          ? highlighted.map((lineTokens, i) => (
              <div key={i} className="min-w-0 whitespace-pre leading-5">
                {lineTokens.length === 0
                  ? " "
                  : lineTokens.map((t, j) => (
                      <span key={j} style={{ color: t.color }}>
                        {t.content}
                      </span>
                    ))}
              </div>
            ))
          : lines.map((line, i) => (
              <div key={i} className="min-w-0 whitespace-pre leading-5">
                {line || " "}
              </div>
            ))}
      </div>
    </div>
  );
}

export function FoldersTab() {
  const { t } = useTranslation();
  const { folders, setFolders } = useWorkspace();
  const { theme } = useTheme();
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const [viewMode, setViewMode] = useState<"files" | "commits">("files");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(folders),
  );
  const [dirCache, setDirCache] = useState<Record<string, DirEntryInfo[]>>({});
  const loadingRef = useRef<Set<string>>(new Set());
  const entryIsDirRef = useRef<Map<string, boolean>>(new Map());

  // Recarrega diretórios quando o branch git muda
  const currentBranch = useBranchStore((s) => (folders[0] ? s.byDir[folders[0]]?.current : undefined))
  const branchInfo = useBranchStore((s) => (folders[0] ? s.infoByDir[folders[0]] : undefined))
  const syncBusyDir = useBranchStore((s) => s.syncBusyDir)
  const refreshInfo = useBranchStore((s) => s.refreshInfo)
  const pullChanges = useBranchStore((s) => s.pullChanges)
  const pushChanges = useBranchStore((s) => s.pushChanges)

const [viewedFile, setViewedFile] = useState<ViewedFile>();
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileImage, setFileImage] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [highlighted, setHighlighted] = useState<HighlightedToken[][] | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number>();
  const [fileBrowserOpen, setFileBrowserOpen] = useState(true);
  const [mdMode, setMdMode] = useState<"edit" | "preview">("preview");

  const [commits, setCommits] = useState<CommitEntry[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsReload, setCommitsReload] = useState(0);

  // Linhas do log com divisores de região (main vs branch atual vs remoto)
  const commitRows = useMemo<CommitRow[]>(() => {
    if (!commits) return [];
    const rows: CommitRow[] = [];
    let prevKey: string | null = null;
    for (const commit of commits) {
      const region = commitRegion(commit, branchInfo);
      const key = region ? `${region.kind}\u0000${region.label}` : null;
      if (region && key !== prevKey) rows.push({ divider: region });
      prevKey = key;
      rows.push({ commit });
    }
    return rows;
  }, [commits, branchInfo]);
  const [syncStatus, setSyncStatus] = useState<
    { kind: "error" | "info"; text: string } | null
  >(null);

  const loadDir = useCallback(async (dirPath: string) => {
    if (loadingRef.current.has(dirPath)) return;
    loadingRef.current.add(dirPath);
    const result = (await window.ipcRenderer.invoke(
      "fs:readdir",
      dirPath,
    )) as ReaddirResult;
    loadingRef.current.delete(dirPath);
    if (result.ok) {
      for (const e of result.entries)
        entryIsDirRef.current.set(e.path, e.isDirectory);
      setDirCache((prev) => ({ ...prev, [dirPath]: result.entries }));
    }
  }, []);

  const reloadRootDir = useCallback(
    (dir: string) => {
      setDirCache((prev) => {
        if (!prev[dir]) return prev
        const next = { ...prev }
        delete next[dir]
        return next
      })
      loadDir(dir)
    },
    [loadDir],
  )

  useEffect(() => {
    if (!currentBranch || folders.length === 0) return
    reloadRootDir(folders[0])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBranch])

  useEffect(() => {
    for (const f of folders) entryIsDirRef.current.set(f, true);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const f of folders) next.add(f);
      return next;
    });
    for (const f of folders) {
      if (!dirCache[f]) loadDir(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders]);

  const handleExpandedChange = useCallback(
    (next: Set<string>) => {
      setExpandedPaths(next);
      for (const p of next) {
        if (!dirCache[p] && entryIsDirRef.current.get(p) !== false) loadDir(p);
      }
    },
    [dirCache, loadDir],
  );

const openLiveFile = useCallback(async (filePath: string) => {
    setViewedFile({ kind: "live", path: filePath });
    setFileLoading(true);
    setFileError(null);
    setFileContent(null);
    setFileImage(null);
    setMdMode("preview");
    if (isImageFile(filePath)) {
      const result = (await window.ipcRenderer.invoke(
        "fs:readFileAsDataUrl",
        filePath,
      )) as { dataUrl: string } | { error: string };
      setFileLoading(false);
      if ("dataUrl" in result) setFileImage(result.dataUrl);
      else setFileError(result.error);
      return;
    }
    const result = (await window.ipcRenderer.invoke(
      "fs:readFile",
      filePath,
    )) as ReadFileResult;
    setFileLoading(false);
    if ("content" in result) setFileContent(result.content);
    else setFileError(result.error);
  }, []);

  const openCommitFile = useCallback(
    async (repoPath: string, hash: string, path: string, deleted: boolean) => {
      setViewedFile({ kind: "commit", repoPath, hash, path, deleted });
      setFileLoading(true);
      setFileError(null);
      setFileContent(null);
      setFileImage(null);
      if (isImageFile(path)) {
        setFileLoading(false);
        setFileError(t("folders.imageNotAvailable"));
        return;
      }
    const result = (await window.ipcRenderer.invoke(
        "git:showFile",
        repoPath,
        hash,
        path,
        deleted,
      )) as ReadFileResult;
      setFileLoading(false);
      setMdMode("preview");
      if ("content" in result) setFileContent(result.content);
      else setFileError(result.error);
    },
    [t],
  );

  const handleSelect = useCallback(
    (path: string) => {
      if (entryIsDirRef.current.get(path) === false) openLiveFile(path);
    },
    [openLiveFile],
  );

  const isMarkdownFile = viewedFile ? /(?:\.md|\.markdown)$/i.test(viewedFile.path) : false;
  const isImage = viewedFile ? isImageFile(viewedFile.path) : false;

  useEffect(() => {
    if (!fileContent || !viewedFile) {
      setHighlighted(null);
      return;
    }
    if (isMarkdownFile && mdMode === "preview") {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    highlightLines(
      fileContent,
      viewedFile.path,
      isDark ? "dark" : "light",
    ).then((result) => {
      if (!cancelled) setHighlighted(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fileContent, viewedFile, isDark, isMarkdownFile, mdMode]);

  const handleCopy = useCallback(async () => {
    if (!fileContent) return;
    await navigator.clipboard.writeText(fileContent);
    setCopied(true);
    window.clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
  }, [fileContent]);

  const handleCopyPath = useCallback(async () => {
    if (!viewedFile) return;
    await navigator.clipboard.writeText(viewedFile.path);
  }, [viewedFile]);

  const handleReveal = useCallback(() => {
    if (viewedFile?.kind !== "live") return;
    window.ipcRenderer
      .invoke("shell:showItemInFolder", viewedFile.path)
      .catch(console.error);
  }, [viewedFile]);

  const syncErrorMessage = useCallback(
    (result: Extract<SyncResult, { ok: false }>) => {
      if (result.kind === "noRemote") return t("folders.noRemote");
      if (result.kind === "noUpstream") return t("folders.noUpstreamPull");
      if (result.kind === "auth")
        return `${t("folders.authFailed")}\n${result.message}`;
      return result.message;
    },
    [t],
  );

  const handlePull = useCallback(async () => {
    const repo = folders[0];
    if (!repo || syncBusyDir) return;
    setSyncStatus(null);
    const result = await pullChanges(repo);
    if (result.ok) {
      reloadRootDir(repo);
      setCommitsReload((n) => n + 1);
      setSyncStatus({ kind: "info", text: t("folders.pulledOk") });
    } else {
      setSyncStatus({ kind: "error", text: syncErrorMessage(result) });
    }
  }, [folders, syncBusyDir, pullChanges, reloadRootDir, syncErrorMessage, t]);

  const [criarRepoOpen, setCriarRepoOpen] = useState(false);

  const handlePush = useCallback(async () => {
    const repo = folders[0];
    if (!repo || syncBusyDir) return;
    setSyncStatus(null);
    const result = await pushChanges(repo);
    if (result.ok) {
      setCommitsReload((n) => n + 1);
      setSyncStatus({
        kind: "info",
        text: result.created ? t("folders.pushedCreated") : t("folders.pushedOk"),
      });
      return;
    }
    // Sem remote não é erro do usuário, é um passo que falta: o modal oferece
    // criar o repositório em vez de só informar que não dá para enviar.
    if (result.kind === "noRemote") {
      setCriarRepoOpen(true);
      return;
    }
    setSyncStatus({ kind: "error", text: syncErrorMessage(result) });
  }, [folders, syncBusyDir, pushChanges, syncErrorMessage, t]);

  useEffect(() => {
    if (viewMode !== "commits" || folders.length === 0) return;
    let cancelled = false;
    setCommitsLoading(true);
    setCommitsError(null);
    void refreshInfo(folders[0]);
    window.ipcRenderer.invoke("git:log", folders[0]).then((result) => {
      if (cancelled) return;
      const r = result as GitLogResult;
      setCommitsLoading(false);
      if (r.ok) {
        setCommits(r.commits);
      } else {
        setCommits([]);
        setCommitsError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [viewMode, folders, commitsReload, refreshInfo]);

  useEffect(() => () => window.clearTimeout(copyTimeoutRef.current), []);

  if (folders.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {t("folders.empty")}
        </p>
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
        <Artifact className="h-full min-w-0 rounded-none border-0 bg-sidebar mt-2">
          <ArtifactHeader className="min-w-0 bg-sidebar">
            <div className="min-w-0">
              {viewedFile ? (
                <>
                  {viewedFile.kind === "commit" && (
                    <ArtifactTitle className="flex items-center gap-1.5 truncate">
                      <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      {viewedFile.hash.slice(0, 7)}
                    </ArtifactTitle>
                  )}
                  <ArtifactDescription className="truncate">
                    {getBreadcrumbs(folders[0], viewedFile.path).map((part, i, arr) => (
                      <span key={i}>
                        {i > 0 && <span className="mx-0.5 text-muted-foreground/50">›</span>}
                        <span className={cn(i === arr.length - 1 && "font-medium text-foreground")}>{part}</span>
                      </span>
                    ))}
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
                onClick={() => setFileBrowserOpen((v) => !v)}
              />
              {viewedFile && (
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
                      {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                      {t("folders.copyContent")}
                    </DropdownMenuItem>
                    {viewedFile.kind === "live" && (
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
          {viewedFile ? (
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {isMarkdownFile && (
                <div className="absolute top-3 right-3 z-20">
                  <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
                    <button
                      type="button"
                      onClick={() => setMdMode("edit")}
                      title={t("folders.editMode")}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full transition-colors",
                        mdMode === "edit"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <PenLineIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setMdMode("preview")}
                      title={t("folders.previewMode")}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full transition-colors",
                        mdMode === "preview"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <EyeIcon className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}
              <ArtifactContent className="min-h-0 min-w-0 flex-1 overflow-auto  p-0">
                {fileLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    {t("common.loading")}
                  </div>
                ) : fileError ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    {fileError}
                  </div>
                ) : fileImage != null ? (
                  <div className="flex min-w-0 items-start justify-center p-4">
                    <Image
                      src={fileImage}
                      alt={viewedFile ? getBaseName(viewedFile.path) : undefined}
                    />
                  </div>
                ) : fileContent != null ? (
                  isMarkdownFile && mdMode === "preview" ? (
                    <div className="min-w-0 px-4 py-4 text-sm text-foreground">
                      <MessageResponse>{fileContent}</MessageResponse>
                    </div>
                  ) : (
                    <CodeView content={fileContent} highlighted={highlighted} />
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
          <div className="flex h-full min-h-0 min-w-0 flex-col bg-code-viewer rounded-lg m-1">
            <Tabs
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              onValueChange={(v) => setViewMode(v as "files" | "commits")}
              value={viewMode}
            >
              <div className="shrink-0 px-3 pt-4 ">
                <TabsList className="w-full">
                  <TabsTrigger className="flex-1 gap-1.5" value="files">
                    <FolderTreeIcon className="size-3.5" />
                    {t("folders.filesTab")}
                  </TabsTrigger>
                  <TabsTrigger className="flex-1 gap-1.5" value="commits">
                    <FolderGit2Icon className="size-3.5" />
                    {t("folders.commitsTab")}
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent
                className="min-h-0 min-w-0 flex-1 overflow-hidden"
                value="files"
              >
                <ScrollArea className="h-full">
                  <FileTree
                    className="rounded-none border-0 bg-transparent mr-2 "
                    expanded={expandedPaths}
                    onExpandedChange={handleExpandedChange}
                    onSelect={handleSelect}
                    selectedPath={
                      viewedFile?.kind === "live" ? viewedFile.path : undefined
                    }
                  >
                    {folders.map((folderPath) => (
                      <FileTreeFolder
                        key={folderPath}
                        name={getBaseName(folderPath)}
                        path={folderPath}
                      >
                        {expandedPaths.has(folderPath) &&
                          renderEntries(
                            dirCache[folderPath],
                            dirCache,
                            expandedPaths,
                          )}
                      </FileTreeFolder>
                    ))}
                  </FileTree>
                </ScrollArea>
              </TabsContent>
              <TabsContent
                className="min-h-0 min-w-0 flex-1 overflow-hidden"
                value="commits"
              >
                <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 px-2 py-1.5">
                  <div className="flex items-center gap-1.5 text-xs">
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span
                      className="max-w-24 truncate font-medium"
                      title={branchInfo?.current ?? undefined}
                    >
                      {branchInfo?.current || t("branch.detached")}
                    </span>
                    {branchInfo?.dirty && (
                      <span
                        className="shrink-0 text-amber-500"
                        title={t("folders.uncommitted")}
                      >
                        *
                      </span>
                    )}
                    {branchInfo?.defaultBranch &&
                      branchInfo.current &&
                      branchInfo.defaultBranch !== branchInfo.current && (
                        <span
                          className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
                          title={t("folders.aheadBehind", {
                            ahead: branchInfo.ahead,
                            behind: branchInfo.behind,
                            branch: branchInfo.defaultBranch,
                          })}
                        >
                          <ArrowUpIcon className="size-2.5 text-emerald-500" />
                          {branchInfo.ahead}
                          <ArrowDownIcon className="ml-1 size-2.5 text-rose-500" />
                          {branchInfo.behind}
                          <span className="ml-1 text-foreground/50">
                            ⇄ {branchInfo.defaultBranch}
                          </span>
                        </span>
                      )}
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={() => void handlePull()}
                      disabled={
                        syncBusyDir !== null ||
                        !branchInfo?.current ||
                        !branchInfo?.hasRemote
                      }
                      title={t("folders.pullHint")}
                      className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-40"
                    >
                      <DownloadIcon className="size-3" />
                      {t("folders.pull")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePush()}
                      disabled={syncBusyDir !== null || !branchInfo?.current}
                      title={t("folders.pushHint")}
                      className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-40"
                    >
                      {syncBusyDir ? (
                        <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : (
                        <UploadIcon className="size-3" />
                      )}
                      {t("folders.push")}
                    </button>
                  </div>
                  {syncStatus && (
                    <p
                      className={cn(
                        "break-words text-[10px] leading-snug",
                        syncStatus.kind === "error"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {syncStatus.text}
                    </p>
                  )}
                </div>
                <ScrollArea className="h-full">
                  <div className="flex flex-col gap-2 p-2 text-xs">
                    {commitsLoading && (
                      <div className="p-4 text-center text-muted-foreground">
                        {t("folders.loadingCommits")}
                      </div>
                    )}
                    {!commitsLoading && commitsError && (
                      <div className="p-4 text-center text-muted-foreground">
                        {t("folders.gitHistoryError")}
                      </div>
                    )}
                    {!commitsLoading &&
                      !commitsError &&
                      commits?.length === 0 && (
                        <div className="p-4 text-center text-muted-foreground">
                          {t("folders.noCommits")}
                        </div>
                      )}
                    {commitRows.map((row) =>
                      row.divider ? (
                        <div
                          key={`divider-${row.divider.kind}-${row.divider.label}`}
                          aria-hidden
                          className="flex items-center gap-2 px-1"
                        >
                          <div
                            className={cn(
                              "h-px flex-1",
                              REGION_STYLES[row.divider.kind].line,
                            )}
                          />
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-2 py-px text-[9px] font-medium",
                              REGION_STYLES[row.divider.kind].chip,
                            )}
                          >
                            {row.divider.kind === "local"
                              ? t("folders.localBranch", {
                                  branch: row.divider.label,
                                })
                              : row.divider.label}
                          </span>
                          <div
                            className={cn(
                              "h-px flex-1",
                              REGION_STYLES[row.divider.kind].line,
                            )}
                          />
                        </div>
                      ) : (
                        <Commit key={row.commit!.hash}>
                          <CommitHeader className="p-2">
                            <CommitInfo className="min-w-0 gap-1">
                              <HoverCard>
                                <HoverCardTrigger
                                  delay={300}
                                  render={
                                    <CommitMessage className="line-clamp-2 cursor-default break-words text-xs leading-snug font-medium">
                                      {row.commit!.message}
                                    </CommitMessage>
                                  }
                                />
                                <HoverCardContent
                                  align="start"
                                  className="w-64 space-y-1.5"
                                  side="right"
                                >
                                  <p className="font-medium leading-snug break-words">
                                    {row.commit!.message}
                                  </p>
                                  {row.commit!.body && (
                                    <p className="whitespace-pre-line break-words text-muted-foreground text-[11px] leading-relaxed">
                                      {row.commit!.body}
                                    </p>
                                  )}
                                  <div className="flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
                                    <CommitHash className="shrink-0 text-[10px]">
                                      {row.commit!.hash.slice(0, 7)}
                                    </CommitHash>
                                    <CommitSeparator className="shrink-0" />
                                    <span className="truncate">
                                      {row.commit!.author}
                                    </span>
                                    <CommitSeparator className="shrink-0" />
                                    <CommitTimestamp
                                      className="shrink-0 text-[10px]"
                                      date={new Date(row.commit!.date)}
                                    />
                                  </div>
                                </HoverCardContent>
                              </HoverCard>
                              <CommitMetadata className="min-w-0 text-[10px]">
                                <CommitHash className="shrink-0 text-[10px]">
                                  {row.commit!.hash.slice(0, 7)}
                                </CommitHash>
                                <CommitSeparator className="shrink-0" />
                                <span className="truncate">
                                  {row.commit!.author}
                                </span>
                                <CommitSeparator className="shrink-0" />
                                <CommitTimestamp
                                  className="shrink-0 text-[10px]"
                                  date={new Date(row.commit!.date)}
                                />
                              </CommitMetadata>
                              <CommitRefBadges
                                refs={row.commit!.refs}
                                current={branchInfo?.current}
                                defaultBranch={branchInfo?.defaultBranch}
                              />
                            </CommitInfo>
                          </CommitHeader>
                          {row.commit!.files.length > 0 && (
                            <CommitContent className="p-2">
                              <CommitFiles>
                                {row.commit!.files.map((f) => (
                                  <CommitFile
                                    key={f.path}
                                    className="cursor-pointer text-[11px]"
                                    onClick={() =>
                                      openCommitFile(
                                        folders[0],
                                        row.commit!.hash,
                                        f.path,
                                        f.status === "deleted",
                                      )
                                    }
                                  >
                                    <CommitFileInfo>
                                      <CommitFileStatus status={f.status} />
                                      <CommitFileIcon />
                                      <CommitFilePath>{f.path}</CommitFilePath>
                                    </CommitFileInfo>
                                  </CommitFile>
                                ))}
                              </CommitFiles>
                            </CommitContent>
                          )}
                        </Commit>
                      ),
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
            <FolderQuickSwitch folders={folders} onFoldersChange={setFolders} />
          </div>
        </Panel>
      )}
      {folders[0] && (
        <CreateRemoteRepoDialog
          repoPath={folders[0]}
          open={criarRepoOpen}
          onOpenChange={setCriarRepoOpen}
          onCreated={(result) => {
            setCommitsReload((n) => n + 1);
            void refreshInfo(folders[0]);
            setSyncStatus({
              kind: result.pushed ? "info" : "error",
              text: result.pushed
                ? t("createRepo.sucesso", { repo: result.fullName })
                : t("createRepo.criadoSemPush", { repo: result.fullName }),
            });
          }}
        />
      )}
    </PanelGroup>
  );
}
