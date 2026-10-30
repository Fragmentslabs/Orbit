"use client";

/**
 * The right panel of the folders tab: the index of what exists, of what changed and of
 * what happened.
 *
 * Three tabs — the working tree changes (pruned tree, only what changed, already
 * open), the workspace files (full tree, to find a file that
 * may not have changed) and the commit history. The footer belongs to the whole panel,
 * and not to one tab: which project one is acting on, and its branch, count for
 * the three.
 *
 * With the panel narrow, only the active tab shows the name; the others stay in the
 * icon. Three names do not fit in the 200px floor, and the active one is the only one that needs
 * to identify itself.
 *
 * It neither opens nor displays any file: it only tells the parent which one was chosen and
 * with what lens (the changes list asks for the diff; the full tree, the
 * content).
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloudIcon,
  DownloadIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  Loader2,
  RefreshCwIcon,
  TagIcon,
  UploadIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import { BranchSelector } from "@/src/components/branch-selector";
import { CreateRemoteRepoDialog } from "@/src/components/create-remote-repo-dialog";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  type GitFileStatus,
} from "@/src/components/ai/file-tree";
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
import {
  useBranchStore,
  type BranchSyncInfo,
  type SyncResult,
} from "@/src/stores/branch-store";
import {
  getBaseName,
  groupByFolder,
  joinPath,
  repoForPath,
  type CommitEntry,
  type DeletedEntry,
  type DirEntryInfo,
  type GitLogResult,
  type GitNumstatResult,
  type GitRepoEntry,
  type GitStatusEntry,
  type GitStatusResult,
  type LineStat,
  type ReaddirResult,
  type ViewerLens,
} from "@/src/lib/folders";
import { useGitRepos } from "@/src/lib/use-git-repos";
import type { WsMatchOptions } from "@/src/lib/ipc";
import { WorkspaceSearch } from "@/src/components/workspace-search";
import { Truncate } from "@/components/ui/truncated-text"

/** Mode of the panel pair — the same as the tab selected on the right. */
export type BrowserTab = "files" | "changes" | "commits";

export interface FileBrowserProps {
  folders: string[];
  onFoldersChange: (folders: string[]) => void;
  /**
   * Active tab. It is not only the index's: the whole left panel follows this
   * mode (tree + one file, or list + stacked diffs).
   */
  tab: BrowserTab;
  onTabChange: (tab: BrowserTab) => void;
  /** Path of the open working tree file, to highlight it in the tree. */
  selectedPath?: string;
  /** File chosen in one of the lists; `deleted` marks the ghost of a deleted one. */
  onSelectFile: (path: string, deleted: boolean, lens: ViewerLens) => void;
  /**
   * Bring a file into view in the stacked reading. The path goes RELATIVE to the
   * repo, which is how the patch names the files.
   */
  onReveal: (relPath: string) => void;
  /** Reload request of the stacked reading — it lives in the other panel. */
  onRefreshChanges: () => void;
  /** File chosen inside a commit card. */
  onOpenCommitFile: (
    repoPath: string,
    hash: string,
    path: string,
    deleted: boolean,
    lens: ViewerLens,
  ) => void;
  /**
   * The search query also marks the file open in the viewer. It comes from
   * outside because the mark lives in the editor, on the other side of the split. An empty query
   * clears it.
   *
   * Replacing in the open file does NOT stay here: the panel list is the whole
   * workspace, and the button there replaces in all of them. The focused file only enters the
   * modal (⌘P), where it is the subject.
   */
  onHighlightQuery?: (query: string, options: WsMatchOptions) => void;
  /**
   * Opens a search result already on the clicked line. Without that the viewer
   * would open the file at the top, and the found excerpt would be off screen.
   */
  onOpenOccurrence?: (path: string, line: number) => void;
  /**
   * Which files were written from outside ("replace in all"). The
   * viewer uses the list to reload whatever is open.
   */
  onReplaced?: (paths: string[]) => void;
}

// ── Regions of the commit log (VS Code style) ───────────────────────────
type CommitRegionKind = "default" | "pushed" | "local";

interface CommitRegion {
  kind: CommitRegionKind;
  label: string;
}

interface CommitRow {
  divider?: CommitRegion;
  commit?: CommitEntry;
}

const REGION_STYLES: Record<CommitRegionKind, { line: string; chip: string }> =
  {
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

/** Region of a commit: main branch, current branch already on the remote, or current branch local only. */
function commitRegion(
  commit: CommitEntry,
  info: BranchSyncInfo | undefined,
): CommitRegion | null {
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

// ── Ref badges in the cards ─────────────────────────────────────────────
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
  default:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
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
    
      <Truncate>
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
          <Truncate text={name}>
            <span className="truncate">{name}</span>
        </Truncate>
      </span>
      </Truncate>
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
  const classified = refs.map((ref) =>
    classifyRef(ref, current, defaultBranch),
  );
  // Branches and tags in independent groups: tags always appear next to
  // the branches, without being discarded by the branch badge limit.
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
  dirPath: string,
  entries: DirEntryInfo[] | undefined,
  dirCache: Record<string, DirEntryInfo[]>,
  expandedPaths: Set<string>,
  gitStatus: Record<string, GitStatusEntry>,
  deletedByDir: Record<string, DeletedEntry[]>,
): ReactNode[] | null {
  if (!entries) return null;
  const children: ReactNode[] = entries.map((entry) =>
    entry.isDirectory ? (
      <FileTreeFolder key={entry.path} name={entry.name} path={entry.path}>
        {expandedPaths.has(entry.path) &&
          renderEntries(
            entry.path,
            dirCache[entry.path],
            dirCache,
            expandedPaths,
            gitStatus,
            deletedByDir,
          )}
      </FileTreeFolder>
    ) : (
      <FileTreeFile
        key={entry.path}
        name={entry.name}
        path={entry.path}
        status={gitStatus[entry.path]?.status}
      />
    ),
  );
  // Deleted files (they do not exist on disk): they enter as ghosts in the
  // parent directory, with the D indicator — clicking opens the file as deleted.
  const deleted = deletedByDir[dirPath];
  if (deleted) {
    for (const d of deleted) {
      children.push(
        <FileTreeFile
          key={d.path}
          name={d.name}
          path={d.path}
          status="deleted"
        />,
      );
    }
  }
  return children;
}

// ── Tree of the changes ─────────────────────────────────────────────────

interface ChangeFileNode {
  path: string;
  name: string;
  status: GitFileStatus;
  stat?: LineStat;
}

interface ChangeDirNode {
  path: string;
  name: string;
  dirs: ChangeDirNode[];
  files: ChangeFileNode[];
}

/**
 * Builds the tree of the changes from the git status.
 *
 * Only the directories that contain some change exist: it is a pruned tree,
 * the opposite of the full tree of the other tab. There one looks for a file that may
 * not have changed; here only what changed matters, and each folder level only
 * exists to give the path of the file.
 */
function buildChangeTree(
  root: string,
  files: ChangeFileNode[],
): { root: ChangeDirNode; dirPaths: string[] } {
  const base = root.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const rootNode: ChangeDirNode = {
    path: base,
    name: getBaseName(root),
    dirs: [],
    files: [],
  };
  const dirs = new Map<string, ChangeDirNode>([[base, rootNode]]);

  for (const file of files) {
    const abs = file.path.replace(/\\/g, "/");
    const rel = abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
    const parts = rel.split("/").filter(Boolean);
    const name = parts.pop() ?? rel;
    let cur = rootNode;
    let curPath = base;
    for (const part of parts) {
      curPath = `${curPath}/${part}`;
      let next = dirs.get(curPath);
      if (!next) {
        next = { path: curPath, name: part, dirs: [], files: [] };
        dirs.set(curPath, next);
        cur.dirs.push(next);
      }
      cur = next;
    }
    cur.files.push({ ...file, name });
  }

  const sortNode = (node: ChangeDirNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of node.dirs) sortNode(d);
  };
  sortNode(rootNode);

  return {
    root: rootNode,
    dirPaths: [...dirs.keys()].filter((p) => p !== base),
  };
}

/**
 * A root of the changes tree: the chat folder that owns the changes and the
 * pruned tree built from it.
 */
interface ChangeGroup {
  /** Absolute path of the folder (the main one or one of the attached ones). */
  path: string;
  name: string;
  root: ChangeDirNode;
  dirPaths: string[];
}

/** Draws one level of the pruned tree: folders first, then the files. */
function renderChangeEntries(
  node: ChangeDirNode,
  expanded: Set<string>,
): ReactNode[] {
  return [
    ...node.dirs.map((dir) => (
      <FileTreeFolder key={dir.path} name={dir.name} path={dir.path}>
        {expanded.has(dir.path) && renderChangeEntries(dir, expanded)}
      </FileTreeFolder>
    )),
    ...node.files.map((f) => (
      <FileTreeFile
        key={f.path}
        name={f.name}
        path={f.path}
        status={f.status}
        stat={f.stat}
      />
    )),
  ];
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
        
          <Truncate>
              <span className="flex-1 truncate text-left">{primaryName}</span>
          </Truncate>
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
              
                <Truncate>
                    <span className="flex-1 truncate text-left">
                    {getBaseName(f)}
                  </span>
                </Truncate>
              {folders[0] === f && <CheckIcon className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FileBrowser({
  folders,
  onFoldersChange,
  selectedPath,
  tab,
  onTabChange,
  onSelectFile,
  onReveal,
  onRefreshChanges,
  onOpenCommitFile,
  onHighlightQuery,
  onOpenOccurrence,
  onReplaced,
}: FileBrowserProps) {
  const { t } = useTranslation();
  /**
   * The history is the third tab, and the log is only fetched when it is in view
   * — hence it being derived from the tab, and not its own state: the effects that depend
   * on it keep working, now without being able to diverge from what is on screen.
   */
  const commitsOpen = tab === "commits";
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(folders),
  );
  const [dirCache, setDirCache] = useState<Record<string, DirEntryInfo[]>>({});
  const loadingRef = useRef<Set<string>>(new Set());
  /**
   * Number of the last requested read of each directory. A response that arrives
   * after a newer read is discarded — without that, the refresh would lose
   * to the listing that was already in flight and the tree would keep the old data.
   */
  const loadSeqRef = useRef<Map<string, number>>(new Map());
  const entryIsDirRef = useRef<Map<string, boolean>>(new Map());

  // ── Repositories of this working folder ───────────────────────────────
  // A workspace may have git in the folder itself and/or in subfolders with their own repo
  // (`front/`, `back/`), each with its own. The panel talks to ONE at a time — the
  // active one, which the footer, the changes list and the tree indicators
  // follow. With no repo discovered the path goes back to being the root folder, which
  // is exactly the usual behavior.
  const repos = useGitRepos(folders);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  /** Open section of the accordion — one at a time: opening another closes the first. */
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const repo = activeRepo ?? folders[0];
  // With no repo discovered there is no accordion: the working folder list stays
  // open, alone and without a header.
  const openPath = repos.length > 0 ? openRepo : (repo ?? null);
  // Stable on purpose: it feeds the status and numstat loaders, which are
  // an effect dependency — recreating the list on every render would become a loop.
  const repoSections = useMemo<GitRepoEntry[]>(
    () =>
      repos.length > 0
        ? repos
        : repo
          ? [{ path: repo, name: getBaseName(repo), relative: "" }]
          : [],
    [repos, repo],
  );

  // Reloads directories when the git branch changes
  const currentBranch = useBranchStore((s) =>
    repo ? s.byDir[repo]?.current : undefined,
  );
  const branchInfo = useBranchStore((s) =>
    repo ? s.infoByDir[repo] : undefined,
  );
  // Header of each accordion repo: branch and distance from the remote come from the
  // same per-folder cache the footer uses.
  const branchByDir = useBranchStore((s) => s.byDir);
  const infoByDir = useBranchStore((s) => s.infoByDir);
  const syncBusyDir = useBranchStore((s) => s.syncBusyDir);
  const refreshInfo = useBranchStore((s) => s.refreshInfo);
  const pullChanges = useBranchStore((s) => s.pullChanges);
  const pushChanges = useBranchStore((s) => s.pushChanges);

  // Git status of the working tree, keyed by absolute path (indicators in the tree)
  const [gitStatus, setGitStatus] = useState<Record<string, GitStatusEntry>>(
    {},
  );
  /** +N/-N by ABSOLUTE path — git returns it relative to the repo, and here it already
   *  comes joined with its folder, like the status. */
  const [numstat, setNumstat] = useState<Record<string, LineStat>>({});
  const [refreshing, setRefreshing] = useState(false);

  const [commits, setCommits] = useState<CommitEntry[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsReload, setCommitsReload] = useState(0);
  const [commitsHasMore, setCommitsHasMore] = useState(false);
  const [commitsLoadingMore, setCommitsLoadingMore] = useState(false);
  // Synchronous mutual exclusion ref (avoids two simultaneous pages with the same skip)
  const commitsLoadingMoreRef = useRef(false);
  // Epoch of the initial load: it discards appends from an old page that arrives
  // after a reload (pull/push/folder switch).
  const commitsEpochRef = useRef(0);
  const commitsEndRef = useRef<HTMLDivElement | null>(null);

  const [syncStatus, setSyncStatus] = useState<{
    kind: "error" | "info";
    text: string;
  } | null>(null);
  const [createRepoOpen, setCreateRepoOpen] = useState(false);

  const loadDir = useCallback(async (dirPath: string, force = false) => {
    if (!force && loadingRef.current.has(dirPath)) return;
    const seq = (loadSeqRef.current.get(dirPath) ?? 0) + 1;
    loadSeqRef.current.set(dirPath, seq);
    loadingRef.current.add(dirPath);
    const result = (await window.ipcRenderer.invoke(
      "fs:readdir",
      dirPath,
    )) as ReaddirResult;
    // Old response: there is already a newer read of this directory on the way.
    if (loadSeqRef.current.get(dirPath) !== seq) return;
    loadingRef.current.delete(dirPath);
    if (result.ok) {
      for (const e of result.entries)
        entryIsDirRef.current.set(e.path, e.isDirectory);
      setDirCache((prev) => ({ ...prev, [dirPath]: result.entries }));
    }
  }, []);

  /**
   * Re-reads the whole tree in view: the roots and every open folder.
   *
   * Before, only the root was re-read, and the file created outside it — inside an
   * open subfolder, which is where one almost always saves — kept being missing,
   * because the subfolder listing came from the cache and nothing invalidated it. The cache
   * of the CLOSED folders is discarded, and not re-read: on opening, they read from
   * disk, which is what one expects from a freshly updated tree.
   *
   * What is open is NOT erased before the re-read: the old listing stays
   * on screen until the new one arrives, instead of the folder blinking empty.
   */
  const reloadTree = useCallback(() => {
    const visible = new Set<string>(folders);
    for (const p of expandedPaths) visible.add(p);
    setDirCache((prev) => {
      const next = { ...prev };
      for (const dir of Object.keys(next)) {
        if (!visible.has(dir)) delete next[dir];
      }
      return next;
    });
    for (const dir of visible) void loadDir(dir, true);
  }, [folders, expandedPaths, loadDir]);

  // ── Status of the workspace, not of a single repo ─────────────────────
  // The tree and the changes list show the WORKSPACE: in a workspace with
  // `front/` and `back/`, the changes of both appear, each one under its own
  // project. That is why the status is read from all the discovered repos — and the
  // keys become ABSOLUTE paths, because two folders may have the same
  // `src/index.ts` and the relative key would collide.
  const loadGitStatus = useCallback(async () => {
    const map: Record<string, GitStatusEntry> = {};
    for (const target of repoSections) {
      const result = (await window.ipcRenderer.invoke(
        "git:status",
        target.path,
      )) as GitStatusResult;
      if (!result.ok) continue;
      for (const entry of result.entries) {
        map[joinPath(target.path, entry.path)] = entry;
      }
    }
    setGitStatus(map);
  }, [repoSections]);

  // Lines per file, for the "+N -N" of the changes list. A numstat failure
  // is not a screen error: without the numbers the list is still useful.
  const loadNumstat = useCallback(async () => {
    const map: Record<string, LineStat> = {};
    for (const target of repoSections) {
      const result = (await window.ipcRenderer.invoke(
        "git:workingNumstat",
        target.path,
      )) as GitNumstatResult;
      if (!result.ok) continue;
      for (const [relPath, stat] of Object.entries(result.stats)) {
        map[joinPath(target.path, relPath)] = stat;
      }
    }
    setNumstat(map);
  }, [repoSections]);

  // Reloads the indicators on mount, on folder/branch switch, on returning to the
  // lists (pull/push/disk may have changed the working tree) or asking for a refresh.
  // With the history closed, none of that appears on screen.
  useEffect(() => {
    if (commitsOpen) return;
    void loadGitStatus();
    void loadNumstat();
  }, [commitsOpen, tab, loadGitStatus, loadNumstat, currentBranch]);

  // The footer branch counts for both modes and cannot depend on the
  // history having been opened at some point — that is where the lying "Detached"
  // came from: with no data loaded, the label fell into the void.
  useEffect(() => {
    if (repo) void refreshInfo(repo);
  }, [repo, refreshInfo]);

  // The previous choice survives a refresh or a pull: it only falls when
  // that repo stopped existing. With none discovered, the panel goes back to
  // talking to the working folder — the usual behavior.
  useEffect(() => {
    setActiveRepo((prev) =>
      prev && repos.some((x) => x.path === prev)
        ? prev
        : (repos[0]?.path ?? null),
    );
    setOpenRepo((prev) =>
      prev && repos.some((x) => x.path === prev)
        ? prev
        : (repos[0]?.path ?? null),
    );
  }, [repos]);

  // The header of each repo shows its branch — and that costs a few
  // git commands per repo. It is worth it with the history in view (that is when the headers
  // exist) and with more than one project, which is when the footer chip lists the
  // branch of each one; the active repo's one, that the footer asks for all the time.
  useEffect(() => {
    if (!commitsOpen && repos.length < 2) return;
    for (const r of repos) void refreshInfo(r.path);
  }, [commitsOpen, repos, refreshInfo]);

  // Exclusive accordion: opening one section closes the other. Clicking the one that is already
  // open collapses it — and the repo keeps being the active one of the panel.
  const handleRepoClick = useCallback((path: string) => {
    setOpenRepo((prev) => (prev === path ? null : path));
    setActiveRepo(path);
  }, []);

  /**
   * Choosing which project the panel acts on — through the footer chip, which is where the
   * choice is visible. The history goes along: with the section open in another repo,
   * the list would show one and the footer would talk about another, and pull/push would go
   * to the wrong repository.
   */
  const handleRepoPick = useCallback((path: string) => {
    setOpenRepo(path);
    setActiveRepo(path);
  }, []);

  /**
   * The footer follows the focused file: it is ITS repo that the branch selector and the
   * pull/push reach — the branch switch per folder, as in VS Code.
   *
   * Without this the footer changed only through the history: the same action (focusing a file)
   * swapped the branch below in one tab and not in the other, which was what did not add up.
   */
  const focusRepoOf = useCallback(
    (filePath: string) => {
      const owner = repoForPath(repoSections, filePath);
      if (owner) setActiveRepo(owner);
    },
    [repoSections],
  );

  // Groups deleted files by parent directory (ghost layer in the tree).
  const deletedByDir = useMemo(() => {
    const map: Record<string, DeletedEntry[]> = {};
    for (const [absPath, entry] of Object.entries(gitStatus)) {
      if (entry.status !== "deleted") continue;
      const idx = absPath.lastIndexOf("/");
      const dir = idx >= 0 ? absPath.slice(0, idx) : absPath;
      const name = idx >= 0 ? absPath.slice(idx + 1) : absPath;
      const list = map[dir] ?? [];
      list.push({ path: absPath, name });
      map[dir] = list;
    }
    return map;
  }, [gitStatus]);

  // ── The changes list ──────────────────────────────────────────────────
  const changeFiles = useMemo<ChangeFileNode[]>(
    () =>
      Object.entries(gitStatus).map(([abs, entry]) => ({
        path: abs,
        name: getBaseName(abs),
        status: entry.status,
        stat: numstat[abs],
      })),
    [gitStatus, numstat],
  );

  /**
   * The roots of the changes tree.
   *
   * With a single repo, the tree is born in it (or in the working folder) — the usual
   * path. With more than one, each chat folder that HAS changes becomes a
   * root: in a workspace with `front/` and `back/` that puts each project under
   * its name, and with a folder attached to the chat its changes appear along.
   * Before, only the main folder was read, and the attached ones were left out.
   */
  const changeGroups = useMemo<ChangeGroup[]>(() => {
    const fallback = repo ?? folders[0] ?? "";
    if (repos.length <= 1) {
      const { root, dirPaths } = buildChangeTree(fallback, changeFiles);
      return [
        {
          path: fallback,
          name: getBaseName(fallback),
          root,
          dirPaths,
        },
      ];
    }

    // The file counts only once (the most specific folder that contains it), and a
    // file of a folder that is no longer in the list does not disappear: it falls into the
    // `fallback` until the next read.
    return groupByFolder(folders, changeFiles, fallback).map(
      ({ folder, files }) => {
        const { root, dirPaths } = buildChangeTree(folder, files);
        return {
          path: folder,
          name: getBaseName(folder),
          root,
          dirPaths,
        };
      },
    );
  }, [repos.length, folders, repo, changeFiles]);

  const changeDirPaths = useMemo(
    () => changeGroups.flatMap((group) => group.dirPaths),
    [changeGroups],
  );
  /**
   * With more than one folder with changes each one becomes a folder of the tree, with
   * its name — it is what says which project the file down there belongs to.
   */
  const changeShowFolders = changeGroups.length > 1;
  /** What opens and closes in the list: the subfolders and, when labeled, the root. */
  const changeExpandable = useMemo(
    () =>
      changeShowFolders
        ? [...changeGroups.map((group) => group.path), ...changeDirPaths]
        : changeDirPaths,
    [changeShowFolders, changeGroups, changeDirPaths],
  );

  // Folders of the changes list are ALL born open — it is the point of the tab: seeing
  // what changed without having to open the way. Storing what was CLOSED (and not what
  // was opened) is what makes the folder the person collapsed stay
  // collapsed when the git status reloads.
  const [collapsedChanges, setCollapsedChanges] = useState<Set<string>>(
    new Set(),
  );
  const changesExpanded = useMemo(() => {
    const next = new Set(changeExpandable);
    for (const p of collapsedChanges) next.delete(p);
    return next;
  }, [changeExpandable, collapsedChanges]);
  const handleChangesExpandedChange = useCallback(
    (next: Set<string>) => {
      setCollapsedChanges(
        new Set(changeExpandable.filter((p) => !next.has(p))),
      );
    },
    [changeExpandable],
  );

  useEffect(() => {
    if (!currentBranch || folders.length === 0) return;
    // Switching branch changes the content of any subfolder, not only of the root.
    reloadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBranch]);

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

  /**
   * Full tree: a changed file leads to the stacked reading, in its
   * section. A file without changes opens for editing — it is the other reason to click
   * a file, and the only one the reading does not serve.
   */
  const handleSelect = useCallback(
    (path: string) => {
      // The changed check comes before the directory one: a deleted file
      // is not in any disk listing, so it would have no way of passing.
      if (gitStatus[path]) {
        // The ABSOLUTE path goes: with more than one repository, the relative one does not
        // say which project the file belongs to.
        focusRepoOf(path);
        onReveal(path);
        return;
      }
      if (entryIsDirRef.current.get(path) === false) {
        focusRepoOf(path);
        onSelectFile(path, false, "content");
      }
    },
    [gitStatus, focusRepoOf, onReveal, onSelectFile],
  );

  /**
   * Changes list: opening a file is wanting to see WHAT CHANGED in it, so
   * the lens already comes in the diff. A click on a folder is not a selection — it is just open/close.
   */
  const handleSelectChange = useCallback(
    (path: string) => {
      if (!gitStatus[path]) return;
      // Absolute path, as in the tree click: it is what identifies the repo.
      focusRepoOf(path);
      onReveal(path);
    },
    [gitStatus, focusRepoOf, onReveal],
  );

  const handleRefresh = useCallback(async () => {
    if (!repo || refreshing) return;
    setRefreshing(true);
    try {
      // The tree is of the whole working folder: roots AND open folders — the
      // file created by hand in a subfolder did not appear when only the root was
      // re-read.
      reloadTree();
      onRefreshChanges();
      // Branch, dirty `*` and ↑↓ of the footer/headers live in the per-folder cache
      // of the branch-store: without this read the button updated the tree and the
      // changes, but left the snapshot of the repository as it was before.
      await Promise.all([
        loadGitStatus(),
        loadNumstat(),
        ...repoSections.map((target) => refreshInfo(target.path)),
      ]);
      // The button is the only "refresh" of the panel and counts for the three tabs: in the
      // history, what there is to refresh is the log.
      setCommitsReload((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  }, [
    repo,
    repoSections,
    refreshing,
    reloadTree,
    loadGitStatus,
    loadNumstat,
    refreshInfo,
    onRefreshChanges,
  ]);

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
    if (!repo || syncBusyDir) return;
    setSyncStatus(null);
    const result = await pullChanges(repo);
    if (result.ok) {
      // The pull may bring files to any open folder.
      reloadTree();
      // And what it brought also changes the stacked diff: without this it only
      // renewed on the manual refresh or when remounting the panel.
      onRefreshChanges();
      void loadGitStatus();
      void loadNumstat();
      setCommitsReload((n) => n + 1);
      setSyncStatus({ kind: "info", text: t("folders.pulledOk") });
    } else {
      setSyncStatus({ kind: "error", text: syncErrorMessage(result) });
    }
  }, [
    repo,
    syncBusyDir,
    pullChanges,
    reloadTree,
    onRefreshChanges,
    loadGitStatus,
    loadNumstat,
    syncErrorMessage,
    t,
  ]);

  const handlePush = useCallback(async () => {
    if (!repo || syncBusyDir) return;
    setSyncStatus(null);
    const result = await pushChanges(repo);
    if (result.ok) {
      // A push only touches the remote reference: the tree and the local status stay
      // as they were. What changes is the local/remote badge of the commits.
      setCommitsReload((n) => n + 1);
      setSyncStatus({
        kind: "info",
        text: result.created
          ? t("folders.pushedCreated")
          : t("folders.pushedOk"),
      });
      return;
    }
    // With no remote it is not a user error, it is a missing step: the modal offers
    // to create the repository instead of only informing that it cannot be sent.
    if (result.kind === "noRemote") {
      setCreateRepoOpen(true);
      return;
    }
    setSyncStatus({ kind: "error", text: syncErrorMessage(result) });
  }, [repo, syncBusyDir, pushChanges, syncErrorMessage, t]);

  useEffect(() => {
    if (!commitsOpen || !repo) return;
    let cancelled = false;
    ++commitsEpochRef.current;
    setCommitsLoading(true);
    setCommitsError(null);
    setCommitsHasMore(false);
    setCommitsLoadingMore(false);
    commitsLoadingMoreRef.current = false;
    void refreshInfo(repo);
    window.ipcRenderer.invoke("git:log", repo).then((result) => {
      if (cancelled) return;
      const r = result as GitLogResult;
      setCommitsLoading(false);
      if (r.ok) {
        setCommits(r.commits);
        setCommitsHasMore(r.hasMore);
      } else {
        setCommits([]);
        setCommitsHasMore(false);
        setCommitsError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [commitsOpen, repo, commitsReload, refreshInfo]);

  const loadMoreCommits = useCallback(() => {
    if (!repo || !commits || commitsLoading || commitsHasMore === false) return;
    // commitsLoadingMore of the state is not synchronous: the ref guarantees mutual exclusion
    // even with the IntersectionObserver firing several times in the same tick.
    if (commitsLoadingMoreRef.current) return;
    commitsLoadingMoreRef.current = true;
    const epoch = commitsEpochRef.current;
    setCommitsLoadingMore(true);
    void window.ipcRenderer
      .invoke("git:log", repo, commits.length)
      .then((result) => {
        if (epoch !== commitsEpochRef.current) return;
        const r = result as GitLogResult;
        if (r.ok) {
          setCommits((prev) => [...(prev ?? []), ...r.commits]);
          setCommitsHasMore(r.hasMore);
        }
      })
      .finally(() => {
        commitsLoadingMoreRef.current = false;
        setCommitsLoadingMore(false);
      });
  }, [repo, commits, commitsLoading, commitsHasMore]);

  // Sentinel at the end of the list: when the ScrollArea viewport approaches the
  // end (300px rootMargin), it loads the next page -> continuous scroll.
  useEffect(() => {
    const el = commitsEndRef.current;
    if (!el) return;
    const viewport = el.closest('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadMoreCommits();
        }
      },
      { root: viewport, rootMargin: "300px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // `openPath` enters the deps because collapsing and reopening the section
    // remounts the sentinel: without that the observer would stay stuck to the old node
    // and the infinite scroll would stop loading after the first collapse.
  }, [commits, loadMoreCommits, openPath]);

  // Log rows with region dividers (main vs current branch vs remote)
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

  const changeCount = changeFiles.length;

  /**
   * The header of a repo in the accordion: name, branch, distance from the remote and the
   * dirty working tree marker.
   *
   * With the section open it stays fixed at the top of the scroll — and the top padding is
   * its own, not the container's, precisely so that, when it sticks, the
   * header itself covers the strip through which the list passes.
   */
  const renderRepoHeader = (section: GitRepoEntry) => {
    const open = openPath === section.path;
    const branch = branchByDir[section.path]?.current;
    const info = infoByDir[section.path];
    return (
      <Hint label={section.relative || section.name}>
        <button
          type="button"
          onClick={() => handleRepoClick(section.path)}
          className={cn(
            "flex w-full items-center gap-1.5 px-2 pb-1.5 pt-2 text-left transition-colors",
            open ? "sticky top-0 z-10 bg-code-viewer" : "hover:bg-accent/50",
          )}
        >
       
       <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate text-xs font-medium">
          {section.name}
        </span>
        {/* Nested repo: the path resolves the doubt about which "front" this one is. */}
        {section.relative.includes("/") && (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
            {section.relative}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          {info?.dirty && (
            <span className="text-amber-500" title={t("folders.uncommitted")}>
              *
            </span>
          )}
          {branch && <span className="max-w-24 truncate">{branch}</span>}
          {(info?.ahead ?? 0) > 0 && (
            <span className="flex items-center text-emerald-500">
              <ArrowUpIcon className="size-2.5" />
              {info?.ahead}
            </span>
          )}
          {(info?.behind ?? 0) > 0 && (
            <span className="flex items-center text-rose-500">
              <ArrowDownIcon className="size-2.5" />
              {info?.behind}
            </span>
          )}
        </span>
      </button>
      </Hint>
    );
  };

  return (
    <>
      <div className="@container flex h-full min-h-0 min-w-0 flex-col bg-code-viewer rounded-lg m-1">
        <Tabs
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          onValueChange={(v) => onTabChange(v as BrowserTab)}
          value={tab}
        >
          <div className="shrink-0 px-3 pt-4 ">
            {/* Three indexes, and not two lists with the history behind a button
                in the footer. The name stays only on the active tab when the panel tightens:
                three names do not fit in the 200px floor, and the active one is the only one that
                needs to identify itself — the others explain themselves by the icon.
                Without the name, they shrink to the icon (`flex-none`) and the remainder
                goes entirely to the active one: it is what makes its name fit whole,
                instead of appearing truncated between two wide and empty tabs. */}
            <TabsList className="w-full">
              <TabsTrigger
                className="group min-w-0 flex-1 @max-[18rem]:flex-none @max-[18rem]:data-[active]:flex-1"
                title={t("folders.filesTab")}
                value="files"
              >
                <FolderTreeIcon className="size-3.5 shrink-0" />
                <Truncate text={t("folders.filesTab")}>
                  <span className="hidden min-w-0 truncate group-data-[active]:inline @[18rem]:inline">
                    {t("folders.filesTab")}
                  </span>
                </Truncate>
              </TabsTrigger>
              <TabsTrigger
                className="group min-w-0 flex-[1.3] @max-[18rem]:flex-none @max-[18rem]:data-[active]:flex-1"
                title={t("folders.changesTab")}
                value="changes"
              >
                <GitCompareArrowsIcon className="size-3.5 shrink-0" />
                <Truncate text={t("folders.changesTab")}>
                  <span className="hidden min-w-0 truncate group-data-[active]:inline @[18rem]:inline">
                    {t("folders.changesTab")}
                  </span>
                </Truncate>
                {changeCount > 0 && (
                  <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1 text-[10px] tabular-nums">
                    {changeCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                className="group min-w-0 flex-1 @max-[18rem]:flex-none @max-[18rem]:data-[active]:flex-1"
                title={t("folders.commitsTab")}
                value="commits"
              >
                <HistoryIcon className="size-3.5 shrink-0" />
                <Truncate text={t("folders.commitsTab")}>
                  <span className="hidden min-w-0 truncate group-data-[active]:inline @[18rem]:inline">
                    {t("folders.commitsTab")}
                  </span>
                </Truncate>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            value="commits"
          >
            <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-border/60 px-2 py-1.5">
              <Hint label={t("folders.pullHint")}>
                <button
                  type="button"
                  onClick={() => void handlePull()}
                  disabled={
                    syncBusyDir !== null ||
                    !branchInfo?.current ||
                    !branchInfo?.hasRemote
                  }
                  className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-40"
                >
       
                       <DownloadIcon className="size-3" />
                <span className="hidden @[16rem]:inline">
                  {t("folders.pull")}
                </span>
              </button>
              </Hint>
              <Hint label={t("folders.pushHint")}>
                <button
                  type="button"
                  onClick={() => void handlePush()}
                  disabled={syncBusyDir !== null || !branchInfo?.current}
                  className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-40"
                >
       
                       {syncBusyDir ? (
                  <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <UploadIcon className="size-3" />
                )}
                <span className="hidden @[16rem]:inline">
                  {t("folders.push")}
                </span>
              </button>
              </Hint>
            </div>
            {syncStatus && (
              <p
                className={cn(
                  "shrink-0 break-words border-b border-border/60 px-2 py-1 text-[10px] leading-snug",
                  syncStatus.kind === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {syncStatus.text}
              </p>
            )}
            {/* `min-h-0 flex-1`, and not `h-full`: this column already has the top bar
                and the sync strip above, so `h-full` made the scroll take
                the WHOLE height of the panel and pass under the footer — which
                has to stay always in view. */}
            <ScrollArea className="min-h-0 flex-1">
              {/* No padding on top: the header of the open repo is `sticky` and
                  brings its own slack — that way, when it sticks to the top, it covers the
                  strip through which the list passes. */}
              {/* `mr-2`: the scrollbar is overlaid on the list, and without the slack
                  it passed over the text of the commits. */}
              <div className="mr-2 flex flex-col gap-1 pb-2 text-xs">
                {repoSections.map((section) => (
                  <section key={section.path} className="flex flex-col">
                    {/* With a single repo there is nothing to choose: the list comes loose,
                        with no header at all. */}
                    {repos.length > 1 && renderRepoHeader(section)}
                    {openPath === section.path && (
                      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
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
                        {/* No rows while the initial load runs: switching
                            repo cannot show the previous one's commit. */}
                        {!commitsLoading &&
                          commitRows.map((row) =>
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
                                          <Truncate text={row.commit!.author}>
                                            <span className="truncate">
                                              {row.commit!.author}
                                            </span>
                                          </Truncate>
                                          <CommitSeparator className="shrink-0" />
                                          <CommitTimestamp
                                            className="shrink-0 text-[10px]"
                                            date={new Date(row.commit!.date)}
                                          />
                                        </div>
                                      </HoverCardContent>
                                    </HoverCard>
                                    {/* The author and its separator leave together when the
                              column tightens: truncating only the text left the two
                              dots glued with an empty gap in the middle. */}
                                    <CommitMetadata className="@container min-w-0 text-[10px]">
                                      <CommitHash className="shrink-0 text-[10px]">
                                        {row.commit!.hash.slice(0, 7)}
                                      </CommitHash>
                                      <span className="hidden min-w-0 items-center gap-2 @[16rem]:flex">
                                        <CommitSeparator className="shrink-0" />
                                        <Truncate text={row.commit!.author}>
                                          <span className="truncate">
                                            {row.commit!.author}
                                          </span>
                                        </Truncate>
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
                                            // What matters in a commit is what it changed:
                                            // it opens already in the diff, with the content one click away.
                                            onOpenCommitFile(
                                              section.path,
                                              row.commit!.hash,
                                              f.path,
                                              f.status === "deleted",
                                              "diff",
                                            )
                                          }
                                        >
                                          <CommitFileInfo>
                                            <CommitFileStatus
                                              status={f.status}
                                            />
                                            <CommitFileIcon />
                                            <CommitFilePath>
                                              {f.path}
                                            </CommitFilePath>
                                          </CommitFileInfo>
                                        </CommitFile>
                                      ))}
                                    </CommitFiles>
                                  </CommitContent>
                                )}
                              </Commit>
                            ),
                          )}
                        {!commitsLoading &&
                          !commitsError &&
                          commits !== null &&
                          commits.length > 0 && (
                            <div
                              ref={commitsEndRef}
                              className="flex min-h-6 items-center justify-center gap-2 p-1"
                            >
                              {commitsLoadingMore && (
                                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                              )}
                              {!commitsLoadingMore && !commitsHasMore && (
                                <span className="text-[10px] text-muted-foreground">
                                  {t("folders.historyEnd")}
                                </span>
                              )}
                            </div>
                          )}
                      </div>
                    )}
                  </section>
                ))}
                {/* Accordion collapsed: the repos stay in view, without a list. */}
                {repos.length > 1 && !openPath && (
                  <p className="px-2 py-4 text-center text-muted-foreground">
                    {t("folders.reposPick")}
                  </p>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            value="changes"
          >
            {changeCount === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {t("folders.changesEmpty")}
              </div>
            ) : (
              <ScrollArea className="h-full">
                <FileTree
                  className="rounded-none border-0 bg-transparent mr-2 "
                  expanded={changesExpanded}
                  onExpandedChange={handleChangesExpandedChange}
                  onSelect={handleSelectChange}
                  selectedPath={selectedPath}
                >
                  {changeGroups.map((group) =>
                    changeShowFolders ? (
                      <FileTreeFolder
                        key={group.path}
                        name={group.name}
                        path={group.path}
                      >
                        {changesExpanded.has(group.path) &&
                          renderChangeEntries(group.root, changesExpanded)}
                      </FileTreeFolder>
                    ) : (
                      <Fragment key={group.path}>
                        {renderChangeEntries(group.root, changesExpanded)}
                      </Fragment>
                    ),
                  )}
                </FileTree>
              </ScrollArea>
            )}
          </TabsContent>
          {/* `flex`, and not a block: the search is a flex item that needs a
              DEFINED height for `flex-1` to count. As a block, its height
              became automatic, the ScrollArea's `h-full` resolved against `auto`
              and the tree was cut by the tab's `overflow-hidden`, without scrolling —
              which only appeared when the content went past the panel height
              (one more folder was enough). */}
          <TabsContent
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            value="files"
          >
            {/* The search is the top of the index, and the tree is its state without
                a query: typing swaps the tree for the results, erasing goes back.
                A single field — name and content —, with no syntax to memorize. */}
            <WorkspaceSearch
              className="min-h-0 flex-1 pt-1"
              openFile={selectedPath ?? null}
              roots={folders}
              onOpen={(path, line) => {
                if (line != null && onOpenOccurrence) onOpenOccurrence(path, line);
                else handleSelect(path);
              }}
              onHighlightQuery={onHighlightQuery}
              onReplaced={onReplaced}
            >
              {/* Flex item (`flex-1`) instead of `h-full`: the height comes from the
                  flex chain of the tab, and not from a percentage that depends
                  on the parent having its own height — the same pattern as the history. */}
              <ScrollArea className="min-h-0 flex-1">
                <FileTree
                  className="rounded-none border-0 bg-transparent mr-2 "
                  expanded={expandedPaths}
                  onExpandedChange={handleExpandedChange}
                  onSelect={handleSelect}
                  selectedPath={selectedPath}
                >
                  {folders.map((folderPath) => (
                    <FileTreeFolder
                      key={folderPath}
                      name={getBaseName(folderPath)}
                      path={folderPath}
                    >
                      {expandedPaths.has(folderPath) &&
                        renderEntries(
                          folderPath,
                          dirCache[folderPath],
                          dirCache,
                          expandedPaths,
                          gitStatus,
                          deletedByDir,
                        )}
                    </FileTreeFolder>
                  ))}
                </FileTree>
              </ScrollArea>
            </WorkspaceSearch>
          </TabsContent>
        </Tabs>

        {/* Footer of the whole panel: which project the panel acts on, its branch
            and the state of the working tree. It counts for the three tabs — the history, which
            used to enter through here, is now one of them. */}
        <div className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border px-2 py-1.5 text-xs">
          {/* With more than one project, the footer SAYS which one it is acting on. Without that,
              opening a history section swapped the branch down here with nothing
              on screen explaining why — it looked like another repo's branch. With a single
              repo there is nothing to choose, and the chip does not appear. */}
          {repos.length > 1 && (
            <DropdownMenu>
              {/* Tooltip outside the trigger, content inside its button — as the `render`
                  element the Hint dropped the trigger props and children (empty button). */}
              <Hint label={t("folders.repoSwitch")}>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      className="flex h-6 min-w-0 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent"
                    >
                      <FolderIcon className="size-3 shrink-0 text-muted-foreground" />
                      <Truncate>
                        <span className="max-w-24 truncate">{repo ? getBaseName(repo) : ""}</span>
                      </Truncate>
                      <ChevronUpIcon className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  }
                />
              </Hint>
              <DropdownMenuContent
                align="start"
                className="w-56 p-1"
                side="top"
              >
                {repos.map((item) => {
                  const info = infoByDir[item.path];
                  const branch = branchByDir[item.path]?.current;
                  const active = item.path === repo;
                  return (
                    <Hint label={item.relative || item.name}>
                      <button
                        key={item.path}
                        type="button"
                        onClick={() => handleRepoPick(item.path)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                          active
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-foreground/10",
                        )}
                      >
       
                                   <span className="min-w-0 flex-1 truncate">
                        {item.name}
                      </span>
                      {info?.dirty && (
                        <span
                          className="shrink-0 text-amber-500"
                          title={t("folders.uncommitted")}
                        >
                          *
                        </span>
                      )}
                      {branch && (
                        <span className="max-w-24 shrink-0 truncate text-[10px] text-muted-foreground">
                          {branch}
                        </span>
                      )}
                      {active && <CheckIcon className="size-3 shrink-0" />}
                    </button>
                    </Hint>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* The same selector as the header, opening upwards: the footer sits at the
              end of the panel, and a dropdown downwards would leave the window. */}
          <BranchSelector compact repoPath={repo} side="top" />
          {branchInfo?.dirty && (
            <span
              className="shrink-0 text-amber-500"
              title={t("folders.uncommitted")}
            >
              *
            </span>
          )}
          {/* The distance to the main branch left here. It is not the branch
              one is on — it is `rev-list main...HEAD`, the comparison with
              `main` — and, glued to the branch selector, it looked like a second branch
              name (the "33 0 ⇄ main" of the doubt). The history already says the same, and
              better: the region dividers mark where the branch starts, and the
              header of each project brings its ↑↓. */}
          <Hint label={t("folders.refresh")}>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}

              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <RefreshCwIcon
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
            </button>
          </Hint>
        </div>

        <FolderQuickSwitch
          folders={folders}
          onFoldersChange={onFoldersChange}
        />
      </div>
      {repo && (
        <CreateRemoteRepoDialog
          repoPath={repo}
          open={createRepoOpen}
          onOpenChange={setCreateRepoOpen}
          onCreated={(result) => {
            setCommitsReload((n) => n + 1);
            void refreshInfo(repo);
            setSyncStatus({
              kind: result.pushed ? "info" : "error",
              text: result.pushed
                ? t("createRepo.success", { repo: result.fullName })
                : t("createRepo.createdWithoutPush", { repo: result.fullName }),
            });
          }}
        />
      )}
    </>
  );
}
