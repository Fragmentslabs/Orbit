"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDownIcon,
  FileCode2Icon,
  GitCompareArrowsIcon,
  HistoryIcon,
  Loader2,
  PanelRightCloseIcon,
} from "lucide-react";
import { parsePatch, type FileDiff } from "@/lib/unified-diff";
import { HighlightedDiffFile } from "@/src/components/diff-lines";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from "@/src/components/ai/artifact";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import {
  getBaseName,
  joinPath,
  type GitRepoEntry,
  type GitWorkingDiffResult,
} from "@/src/lib/folders";
import { Truncate } from "@/components/ui/truncated-text";

/** Request to focus a file: the `nonce` makes the same file count again. */
export interface RevealRequest {
  /**
   * The requested file. It arrives ABSOLUTE when it comes from the panel index (which is what
   * leaves no doubt with several repos) and relative to the repo when the patch is what
   * names it — both cases are resolved here.
   */
  path: string;
  /** Changes on every click: without that, clicking the same file again would do nothing. */
  nonce: number;
}

export interface ChangesViewProps {
  /**
   * Repositories of the workspace: in each folder of the chat (the main one and the attached ones),
   * the folder itself when it is a repo and/or the subfolders with their own git.
   */
  repos: GitRepoEntry[];
  /** Main folder — used only when no repo was discovered. */
  repoRoot: string;
  /** File to bring into view (click on the index on the right). */
  reveal: RevealRequest | null;
  /** Open the file in the editor — this view only reads. It receives an absolute path. */
  onOpenFile: (path: string) => void;
  /** Changes when the footer asks for a reload. */
  reloadToken?: number;
  /**
   * The index tab that is in view. It does not change what is read — the working tree
   * diffs are the same in both — only the empty-state icon, which
   * follows the tab so the reading does not seem to be from another place.
   */
  mode?: "changes" | "commits";
  /** Closes (and reopens) the right panel — the same button as the Files tab. */
  onToggleBrowser: () => void;
}

/**
 * Height of one diff line — `leading-5` in diff-lines.tsx.
 *
 * This is not aesthetics: it is what makes it possible to know where a section that has not
 * been drawn yet is. The body only mounts when it gets near the view, so what
 * is outside it is reserved space; if the height math were wrong, clicking a
 * file would land far from it. That is why the stacked reading does NOT wrap lines —
 * wrapping would make the height of each line unpredictable, and the math, a guess.
 */
const LINE_PX = 20;
/** Hunk header: `px-4 py-1` plus `text-[11px]` with 1.5 line height. */
const HUNK_PX = 24.5;
/**
 * Ceiling of lines drawn per file.
 *
 * The largest diff in this repository has 1,859 lines. Without a ceiling, reaching it mounts
 * ~7 thousand elements and two giant tokenizations at once — the tab chokes
 * exactly on the file the person most wants to read. The rest is one click away.
 */
const MAX_LINES_PER_FILE = 400;

function countLines(file: FileDiff): number {
  return file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

/**
 * Cuts the file at the line ceiling, preserving the numbering.
 *
 * The cut is by line, not by hunk: a hunk may be cut in the middle, and since
 * the renderer counts the numbering from the start of the hunk, the numbers
 * stay right.
 */
function truncateDiff(
  file: FileDiff,
  max: number,
): { body: FileDiff; hidden: number } {
  let budget = max;
  const hunks: FileDiff["hunks"] = [];
  for (const hunk of file.hunks) {
    if (budget <= 1) break;
    const lines = hunk.lines.slice(0, budget - 1);
    hunks.push({ ...hunk, lines });
    budget -= 1 + lines.length;
  }
  const shown = hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  return { body: { ...file, hunks }, hidden: countLines(file) - shown };
}

/** Height the section will have when it mounts — without mounting. */
function heightOf(body: FileDiff): number {
  return countLines(body) * LINE_PX + body.hunks.length * HUNK_PX;
}

/** Key of a section: the same path can exist in two repositories. */
function sectionKey(repoPath: string, filePath: string): string {
  return `${repoPath}::${filePath}`;
}

interface DiffSectionProps {
  file: FileDiff;
  /** Key of the section (repo + path) — what the observer and the scroll use. */
  id: string;
  open: boolean;
  /** Body mounted? Outside the view, only the reserved height. */
  active: boolean;
  flash: boolean;
  showAll: boolean;
  /** Registers the space reserved for the view observer. */
  observe: (el: HTMLElement | null) => void;
  /** Ref of the whole section, for the scroll of "go to the file". */
  sectionRef: (el: HTMLElement | null) => void;
  onToggle: () => void;
  onShowAll: () => void;
  onOpenFile: () => void;
}

function DiffSection({
  file,
  id,
  open,
  active,
  flash,
  showAll,
  observe,
  sectionRef,
  onToggle,
  onShowAll,
  onOpenFile,
}: DiffSectionProps) {
  const { t } = useTranslation();
  const { body, hidden } = useMemo(
    () =>
      showAll
        ? { body: file, hidden: 0 }
        : truncateDiff(file, MAX_LINES_PER_FILE),
    [file, showAll],
  );
  const label =
    file.oldPath === file.newPath
      ? file.newPath
      : `${file.oldPath} → ${file.newPath}`;

  return (
    <section
      ref={sectionRef}
      className={cn(
        "mb-2 overflow-hidden rounded-md border transition-colors",
        flash ? "border-primary/60 ring-1 ring-primary/30" : "border-border/50",
      )}
    >
      <div className="flex items-center gap-1 bg-muted/40 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
        >
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          
            <Truncate>
                <span
                className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                title={label}
              >
                {label}
              </span>
            </Truncate>
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 font-mono text-[11px] tabular-nums">
            {file.added > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">
                +{file.added}
              </span>
            )}
            {file.removed > 0 && (
              <span className="text-red-600 dark:text-red-400">
                -{file.removed}
              </span>
            )}
          </span>
        </button>
        {/* The list on the right leads to the diff, not to the file. Without this door, a
            changed file would be impossible to open for editing. */}
        <Hint label={t("folders.openFile")}>
          <button
            type="button"
            onClick={onOpenFile}

            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FileCode2Icon className="size-3.5" />
          </button>
        </Hint>
      </div>

      {open &&
        (active ? (
          <>
            <div className="min-w-0 overflow-x-auto border-t border-border/50">
              {/* min-w-max: the line does not wrap, so the block grows to the
                  longest line and the horizontal scroll appears — that is what
                  keeps the height of each line at exactly LINE_PX. */}
              <div className="min-w-max font-mono text-xs">
                <HighlightedDiffFile
                  file={body}
                  wrap={false}
                  stickyHeader={false}
                />
              </div>
            </div>
            {hidden > 0 && (
              <button
                type="button"
                onClick={onShowAll}
                className="w-full border-t border-border/50 bg-muted/30 px-3 py-1.5 text-center text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                {t("folders.showMoreLines", { count: hidden })}
              </button>
            )}
          </>
        ) : (
          <div
            ref={observe}
            data-diff-path={id}
            style={{ height: heightOf(body) }}
            className="border-t border-border/50"
          />
        ))}
    </section>
  );
}

/**
 * The reading of the working tree changes: every file stacked, one
 * below the other, as the diff tab has always been.
 *
 * What changed here was the cost. Mounting everything at once fired one
 * Shiki tokenization per side of each file — ~100 at once, in a diff
 * of 8 thousand lines. Now the header of each file (which is the index of the
 * reading) always appears, and the body mounts when it gets near the view: the
 * Shiki runs only on what is being looked at, and the tab opens instantly.
 *
 * And what changed afterwards was the reach: in a workspace with more than one repository
 * (`front/` and `back/`, each with its own git) the reading is not of a single repo —
 * it is of the whole workspace, with the files of each project under its name.
 * Before that the tab tried to read the diff of the root folder, which is not a repo, and what
 * appeared was the git error.
 */
export function ChangesView({
  repos,
  repoRoot,
  reveal,
  onOpenFile,
  reloadToken = 0,
  mode = "changes",
  onToggleBrowser,
}: ChangesViewProps) {
  const { t } = useTranslation();

  // A single repo (the common case) gets no header: the list comes loose, as
  // it always came. With no repo discovered, the reading is of the working folder.
  const list = useMemo<GitRepoEntry[]>(
    () =>
      repos.length > 0
        ? repos
        : repoRoot
          ? [{ path: repoRoot, name: getBaseName(repoRoot), relative: "" }]
          : [],
    [repos, repoRoot],
  );
  const grouped = list.length > 1;

  const [patches, setPatches] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  /** Sections with the body mounted. It only grows: remounting on scrolling back
   *  would redo the tokenization that was just paid for. */
  const [active, setActive] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const lastReveal = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const nextPatches: Record<string, string> = {};
      const nextErrors: Record<string, string> = {};
      // In series on purpose: they are N git processes, and a workspace with several
      // repos must not fire them all at once.
      for (const repo of list) {
        const result = (await window.ipcRenderer.invoke(
          "git:workingDiff",
          repo.path,
        )) as GitWorkingDiffResult;
        if (result.ok) nextPatches[repo.path] = result.patch;
        else nextErrors[repo.path] = result.error;
      }
      if (cancelled) return;
      setPatches(nextPatches);
      setErrors(nextErrors);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list, reloadToken]);

  /** The diff of each project, already split and with its totals. */
  const groups = useMemo(
    () =>
      list.map((repo) => {
        const patch = patches[repo.path];
        const files =
          patch == null
            ? []
            : parsePatch(patch).sort((a, b) =>
                a.newPath.localeCompare(b.newPath),
              );
        const totals = files.reduce(
          (acc, file) => ({
            added: acc.added + file.added,
            removed: acc.removed + file.removed,
          }),
          { added: 0, removed: 0 },
        );
        return { repo, files, totals, error: errors[repo.path] ?? null };
      }),
    [list, patches, errors],
  );

  const totals = useMemo(
    () =>
      groups.reduce(
        (acc, group) => ({
          added: acc.added + group.totals.added,
          removed: acc.removed + group.totals.removed,
        }),
        { added: 0, removed: 0 },
      ),
    [groups],
  );
  const changeCount = useMemo(
    () => groups.reduce((total, group) => total + group.files.length, 0),
    [groups],
  );

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setActive((prev) => {
          let next: Set<string> | null = null;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const path = (entry.target as HTMLElement).dataset.diffPath;
            if (!path || prev.has(path)) continue;
            next ??= new Set(prev);
            next.add(path);
          }
          return next ?? prev;
        });
      },
      // One screen of slack: when the section enters the view, the body has already arrived.
      { rootMargin: "1200px 0px" },
    );
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  const observe = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    observerRef.current?.observe(el);
  }, []);

  /** Brings the requested file into view: opens the section, mounts the body and scrolls to it. */
  useEffect(() => {
    if (!reveal || loading) return;
    if (lastReveal.current === reveal.nonce) return;

    // The path arrives absolute (panel index) or relative to the repo (patch).
    // With several repos only the absolute one leaves no doubt — the relative one matches in the
    // first project that has that file.
    const wanted = reveal.path.replace(/\\/g, "/");
    let key: string | null = null;
    // The repo that matches is the one with the LONGEST path: the root is a prefix of every nested
    // repo, and keeping the first would match the `front/` file with the root.
    let best = -1;
    for (const group of groups) {
      const root = group.repo.path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      if (!wanted.startsWith(root + "/") || root.length <= best) continue;
      best = root.length;
      key = sectionKey(group.repo.path, wanted.slice(root.length + 1));
    }
    if (!key) {
      for (const group of groups) {
        if (group.files.some((file) => file.newPath === wanted)) {
          key = sectionKey(group.repo.path, wanted);
          break;
        }
      }
    }
    if (!key) return;
    lastReveal.current = reveal.nonce;

    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setActive((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setFlash(key);

    // The scroll waits for the layout: the section may have just been reopened, and
    // the ones above are in the right place because the reserved space has the height
    // the body is going to have.
    const frame = window.requestAnimationFrame(() => {
      sections.current
        .get(key)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [reveal, groups, loading]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const markShowAll = useCallback((key: string) => {
    setShowAll((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  return (
    // Same header and same margins as the Files tab (`file-viewer.tsx`): it is the
    // same panel in two modes, and switching between them cannot shift the top
    // nor change the color of the strip.
    <Artifact className="h-full min-w-0 rounded-none border-0 bg-sidebar mt-2">
      <ArtifactHeader className="min-w-0 bg-sidebar">
        <div className="min-w-0">
          <ArtifactTitle className="flex items-center gap-1.5 truncate">
            <GitCompareArrowsIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {t("folders.changesTab")}
          </ArtifactTitle>
        </div>
        <ArtifactActions>
          {changeCount > 0 && (
            <span className="flex shrink-0 items-center gap-2 pr-2 font-mono text-[11px] tabular-nums">
              <span className="text-muted-foreground">
                {t("folders.changesCount", { count: changeCount })}
              </span>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{totals.added}
              </span>
              <span className="text-red-600 dark:text-red-400">
                -{totals.removed}
              </span>
            </span>
          )}
          {/* The button that closes the right panel is the same as the Files tab's —
              and it is what gives the height of the strip: without a 32px target on the side, the
              header shrank and the two tabs did not match. It comes last: the
              corner is exactly what it closes, and that is where one looks. */}
          <ArtifactAction
            icon={PanelRightCloseIcon}
            onClick={onToggleBrowser}
          />
        </ArtifactActions>
      </ArtifactHeader>

      {/* `p-3` on all four sides: without the top slack, the first file of the
          reading stuck to the header. */}
      <ArtifactContent className="min-h-0 min-w-0 overflow-hidden p-3">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("folders.changesLoading")}
          </div>
        ) : changeCount === 0 && !groups.some((g) => g.error) ? (
          // Same empty state as the Files tab: a big icon in the center and the sentence
          // below. The icon follows the tab — in the history the reading is the same,
          // but the whole panel is talking about commits.
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            {mode === "commits" ? (
              <HistoryIcon className="size-16 text-muted-foreground/20" />
            ) : (
              <GitCompareArrowsIcon className="size-16 text-muted-foreground/20" />
            )}
            <p className="text-sm text-muted-foreground">
              {t("folders.changesEmpty")}
            </p>
          </div>
        ) : (
          <div ref={scrollRef} className="h-full overflow-y-auto pr-0.5">
            {groups.map((group) => {
              const showHeader =
                grouped && (group.files.length > 0 || group.error);
              return (
                <div key={group.repo.path}>
                  {showHeader && (
                    <div className="mb-2 flex items-center gap-2 border-b border-border/50 pb-1">
                      <Truncate text={group.repo.name}>
                        <span
                          className="min-w-0 truncate text-xs font-medium"
                        >
                          {group.repo.name}
                        </span>
                      </Truncate>
                      {/* Nested project: the path resolves the doubt about which
                          "front" this one is. */}
                      {group.repo.relative.includes("/") && (
                        <Truncate text={group.repo.relative}>
                          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                            {group.repo.relative}
                          </span>
                        </Truncate>
                      )}
                      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
                        <span className="text-muted-foreground">
                          {t("folders.changesCount", {
                            count: group.files.length,
                          })}
                        </span>
                        {group.totals.added > 0 && (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{group.totals.added}
                          </span>
                        )}
                        {group.totals.removed > 0 && (
                          <span className="text-red-600 dark:text-red-400">
                            -{group.totals.removed}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {group.error && group.files.length === 0 ? (
                    <p className="p-2 text-sm text-destructive">
                      {group.error}
                    </p>
                  ) : (
                    group.files.map((file) => {
                      const key = sectionKey(group.repo.path, file.newPath);
                      return (
                        <DiffSection
                          key={key}
                          id={key}
                          file={file}
                          open={!collapsed.has(key)}
                          active={active.has(key)}
                          flash={flash === key}
                          showAll={showAll.has(key)}
                          observe={observe}
                          sectionRef={(el) => {
                            if (el) sections.current.set(key, el);
                            else sections.current.delete(key);
                          }}
                          onToggle={() => toggle(key)}
                          onShowAll={() => markShowAll(key)}
                          onOpenFile={() =>
                            onOpenFile(joinPath(group.repo.path, file.newPath))
                          }
                        />
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ArtifactContent>
    </Artifact>
  );
}
