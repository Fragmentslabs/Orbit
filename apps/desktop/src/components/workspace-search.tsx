"use client";

/**
 * The unified workspace search.
 *
 * One field, two groups: the files whose NAME matches the query and the
 * OCCURRENCES inside their text. The two come from the same index in the main process, but
 * they cost differently — names are memory (tenths of a millisecond) and
 * occurrences read the disk (~100 ms per pass in this repo). That is why they do not
 * wait for each other: the names appear on the first key, and the occurrences
 * arrive later, with debounce and cancellation.
 *
 * The collapsed group does NOT search — but it also does not lose what it already found: closing
 * "Occurrences" cancels the scan and keeps the list under the header, which
 * stays there to reopen. Making the group disappear would destroy the result and the
 * only way back.
 *
 * The bar is the same in the panel and in the modal (⌘P). What changes is the reach of the
 * replacement: in the panel only "replace in all" (the list is the whole
 * workspace); in the modal, which opens with a file in focus, also "in this file",
 * which swaps in the editor BUFFER — it goes through undo and the automatic
 * saving instead of writing underneath a draft.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ALargeSmallIcon,
  CaseSensitiveIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  ListFilterIcon,
  Loader2,
  RegexIcon,
  ReplaceIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  workspaceApi,
  type WsLineHit,
  type WsMatchOptions,
} from "@/src/lib/ipc";
import { previewLine } from "@/src/lib/text-match";
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/** Wait after the last key. */
const NAME_DEBOUNCE_MS = 90;
const TEXT_DEBOUNCE_MS = 220;
/** Below this the text scan costs more than it delivers. */
const MIN_TEXT_QUERY = 2;

interface NameRow {
  /** Absolute path — it is what the viewer opens. */
  path: string;
  /** Path relative to the root, for display. */
  rel: string;
  name: string;
  dir: string;
  root: string;
}

interface OccurrenceRow {
  path: string;
  rel: string;
  root: string;
  count: number;
  lines: WsLineHit[];
}

export interface WorkspaceSearchProps {
  /** The workspace folders — the search covers all of them. */
  roots: string[];
  /** File open in the viewer, target of "replace in this file". */
  openFile?: string | null;
  /** Opens a result; `line` is 1-based when it came from an occurrence. */
  onOpen: (path: string, line?: number) => void;
  /** Replaces in the BUFFER of the open file (never on disk underneath it). */
  onReplaceInFile?: (
    query: string,
    replacement: string,
    options: WsMatchOptions,
  ) => number;
  /** Tells which files changed on disk, for the panel to reload. */
  onReplaced?: (written: string[]) => void;
  /**
   * The query here also marks the file open in the viewer. Empty
   * clears the mark — the field is the same search, only pointed at the text.
   */
  onHighlightQuery?: (query: string, options: WsMatchOptions) => void;
  variant?: "panel" | "dialog";
  autoFocus?: boolean;
  /**
   * What appears when there is no query — in the panel, the tree. Typing swaps
   * it for the results; erasing brings it back. It is what makes the search a
   * field IN the index, and not a parallel screen.
   */
  children?: ReactNode;
  className?: string;
}

/** Absolute path from the root and the relative one the main process returns. */
function absolutePath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

/** Excerpt of the line cut from the beginning, with the range highlighted. */
function CodeLine({
  text,
  start,
  length,
  tone,
}: {
  text: string;
  start: number;
  length: number;
  tone: "match" | "insert";
}) {
  const before = text.slice(0, start);
  const mid = text.slice(start, start + length);
  const after = text.slice(start + length);
  // Long line: it shows the tail of what comes before, and not the beginning — the
  // highlighted excerpt is the only part that needs to be on screen.
  const lead = before.length > 30 ? `…${before.slice(-30)}` : before;

  return (
    
      <Truncate>
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
          {lead}
          <span
            className={cn(
              "rounded-[3px] px-px",
              // Before in red, after in green — the diff convention, so the
              // preview reads without explanation.
              tone === "match"
                ? "bg-destructive/20 text-destructive"
                : "bg-emerald-500/20 text-emerald-500",
            )}
          >
            {mid}
          </span>
        {after.slice(0, 150)}
      </span>
      </Truncate>
  );
}

/**
 * The line as it would be after the replacement, right below the current one.
 *
 * It is what turns "5 occurrences in 2 files" into a decision: the user
 * sees the text before and after in the place itself, with the swapped part highlighted —
 * without needing to apply to find out, and without undoing afterwards.
 */
function PreviewRow({
  hit,
  replacement,
  options,
}: {
  hit: WsLineHit;
  replacement: string;
  options: WsMatchOptions;
}) {
  const next = previewLine(hit.text, hit, replacement, options);
  const start = Math.max(0, hit.column - 1);
  const inserted = next.length - hit.text.length + hit.length;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="w-6 shrink-0 text-right font-mono text-[9.5px] text-emerald-500/70">
        →
      </span>
      <CodeLine text={next} start={start} length={inserted} tone="insert" />
    </span>
  );
}

/** Small state button — today only the "preserve case", in replace. */
function IconToggle({
  active,
  title,
  onToggle,
  children,
}: {
  active: boolean;
  title: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
        active
          ? "bg-primary/15 text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * An option of the filters popover: icon, label and the check when on.
 * The popover does NOT close on every click — the filters combine with each other, and closing
 * would force reopening to turn the second one on.
 */
function FilterOption({
  active,
  icon,
  label,
  onToggle,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      
        <Truncate>
            <span className="min-w-0 flex-1 truncate">{label}</span>
        </Truncate>
      <CheckIcon
        className={cn("size-3 shrink-0 text-primary", !active && "opacity-0")}
      />
    </button>
  );
}

/** Group header: the click only closes — the list keeps existing. */
function GroupHead({
  open,
  label,
  count,
  onToggle,
}: {
  open: boolean;
  label: string;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-7 w-full items-center gap-1 rounded px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 transition-transform",
          open && "rotate-90",
        )}
      />
      {label}
      <span className="ml-auto rounded-full bg-muted-foreground/15 px-1.5 text-[9.5px] tabular-nums">
        {count}
      </span>
    </button>
  );
}

export function WorkspaceSearch({
  roots,
  openFile,
  onOpen,
  onReplaceInFile,
  onReplaced,
  onHighlightQuery,
  variant = "panel",
  autoFocus = false,
  children,
  className,
}: WorkspaceSearchProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [preserveCase, setPreserveCase] = useState(true);

  const [names, setNames] = useState<NameRow[]>([]);
  const [occurrences, setOccurrences] = useState<OccurrenceRow[]>([]);
  const [matches, setMatches] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [invalidPattern, setInvalidPattern] = useState(false);

  /** Open groups. Closing "Occurrences" cancels the text scan. */
  const [namesOpen, setNamesOpen] = useState(true);
  const [occurrencesOpen, setOccurrencesOpen] = useState(true);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Changes on every replacement so the search runs again. */
  const [reload, setReload] = useState(0);

  const requestSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootsKey = roots.join("\n");
  /**
   * The list of roots is read by ref inside the effects: `rootsKey` is what says
   * that it changed. Without that, every render with a new array (same content)
   * would reschedule the text scan and throw away the result on screen.
   */
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  const options = useMemo<WsMatchOptions>(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);

  // Names: memory, with no long debounce. What appears here is the index list
  // filtered in the main process — the same one the `@` palette uses.
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setNames([]);
      return;
    }
    // Collapsed does not search; and what was already found stays, to reopen.
    if (!namesOpen) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void Promise.all(
        rootsRef.current.map(async (root) => {
          const result = await workspaceApi.names({ root, query: q });
          if (!result.ok) return [];
          return result.hits.map<NameRow>((hit) => ({
            root,
            rel: hit.path,
            path: absolutePath(root, hit.path),
            name: hit.name,
            dir: hit.dir,
          }));
        }),
      ).then((batches) => {
        if (alive) setNames(batches.flat());
      });
    }, NAME_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, namesOpen, rootsKey]);

  // Occurrences: disk. Only with a sufficient query, and only with the group open.
  // A short query CLEARS it (a one-letter result says nothing); a closed group
  // only stops searching and keeps the previous list.
  useEffect(() => {
    const q = query.trim();
    if (q === "" || q.length < MIN_TEXT_QUERY) {
      setOccurrences([]);
      setMatches(0);
      setScanned(0);
      setInvalidPattern(false);
      return;
    }
    if (!occurrencesOpen) return;

    const seq = (requestSeq.current += 1);
    const ids = rootsRef.current.map((_, index) => `ws-${seq}-${index}`);
    let alive = true;
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError(null);
      void Promise.all(
        rootsRef.current.map(async (root, index) => {
          const result = await workspaceApi.text({
            id: ids[index],
            root,
            query: q,
            ...options,
          });
          return { root, result };
        }),
      ).then((batches) => {
        if (!alive) return;
        setBusy(false);
        const rows: OccurrenceRow[] = [];
        let total = 0;
        let filesScanned = 0;
        let invalid = false;
        for (const { root, result } of batches) {
          if (!result.ok) {
            setError(result.error);
            continue;
          }
          filesScanned += result.scanned;
          invalid = invalid || result.invalidPattern === true;
          for (const file of result.occurrences) {
            total += file.count;
            rows.push({
              root,
              rel: file.path,
              path: absolutePath(root, file.path),
              count: file.count,
              lines: file.lines,
            });
          }
        }
        rows.sort((a, b) => b.count - a.count);
        setOccurrences(rows);
        setMatches(total);
        setScanned(filesScanned);
        setInvalidPattern(invalid);
      });
    }, TEXT_DEBOUNCE_MS);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      // Every new key aborts the previous scan: work nobody is going to
      // see cannot keep reading the disk.
      for (const id of ids) void workspaceApi.cancel(id);
    };
  }, [query, options, occurrencesOpen, rootsKey, reload]);

  // The mark in the open file follows the query, without debounce: it is text
  // decoration, not disk reading.
  useEffect(() => {
    onHighlightQuery?.(query.trim(), options);
  }, [query, options, onHighlightQuery]);

  const trimmed = query.trim();
  const canReplaceInFile = openFile != null && onReplaceInFile != null && trimmed !== "";
  const canReplaceAll = occurrences.length > 0 && trimmed !== "";
  const showPreview = replaceOpen && replacement !== "" && trimmed !== "";

  const replaceInFile = useCallback(() => {
    if (!canReplaceInFile || !onReplaceInFile) return;
    setStatus(null);
    const count = onReplaceInFile(trimmed, replacement, {
      ...options,
      preserveCase,
    });
    setStatus(
      count > 0
        ? t("workspaceSearch.replaced", { count, files: 1 })
        : t("workspaceSearch.noReplacements"),
    );
    setReload((value) => value + 1);
  }, [canReplaceInFile, onReplaceInFile, trimmed, replacement, options, preserveCase, t]);

  const replaceAll = useCallback(() => {
    if (!canReplaceAll) return;
    setStatus(null);
    setError(null);
    setBusy(true);

    const byRoot = new Map<string, string[]>();
    for (const occurrence of occurrences) {
      const list = byRoot.get(occurrence.root) ?? [];
      list.push(occurrence.rel);
      byRoot.set(occurrence.root, list);
    }

    void Promise.all(
      [...byRoot.entries()].map(async ([root, targets]) => {
        const result = await workspaceApi.replace({
          root,
          targets,
          query: trimmed,
          replacement,
          ...options,
          preserveCase,
        });
        return result;
      }),
    ).then((results) => {
      setBusy(false);
      let files = 0;
      let count = 0;
      const written: string[] = [];
      for (const result of results) {
        if (!result.ok) {
          setError(result.error);
          continue;
        }
        files += result.files;
        count += result.replacements;
        written.push(...result.written);
        if (result.errors.length > 0) {
          setError(
            t("workspaceSearch.replaceErrors", { count: result.errors.length }),
          );
        }
      }
      setStatus(
        count > 0
          ? t("workspaceSearch.replaced", { count, files })
          : t("workspaceSearch.noReplacements"),
      );
      if (written.length > 0) onReplaced?.(written);
      setReload((value) => value + 1);
    });
  }, [
    canReplaceAll,
    occurrences,
    trimmed,
    replacement,
    options,
    preserveCase,
    onReplaced,
    t,
  ]);

  const clear = useCallback(() => {
    setQuery("");
    setStatus(null);
    setError(null);
    searchRef.current?.focus();
  }, []);

  const rootLabel = useMemo(() => {
    if (roots.length < 2) return null;
    const labels = new Map<string, string>();
    for (const root of roots) {
      const parts = root.split(/[\\/]/).filter(Boolean);
      labels.set(root, parts[parts.length - 1] ?? root);
    }
    return labels;
  }, [roots]);

  const showNames = !replaceOpen;
  /** How many filters are on — the popover button lights up with any. */
  const activeFilters =
    Number(caseSensitive) + Number(wholeWord) + Number(regex);
  const nothingFound =
    trimmed !== "" && !busy && names.length === 0 && matches === 0;
  // In the panel the field is only an outline: the sidebar already is the surface, and a
  // darker background here would open a second box inside the same column. In the
  // modal the surface is the popover — there the field needs to announce itself as a
  // field, otherwise it becomes loose text at the top.
  const fieldClass = variant === "panel" ? "bg-transparent" : "bg-background";
  // The modal does not have the panel frame: the breathing room comes from here, otherwise the field
  // touches the popover edge.
  const pad = variant === "panel" ? "px-2" : "";

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        variant === "dialog" && "p-4",
        className,
      )}
    >
      {/* Bar: query, the three filters and the replace opener. */}
      <div className={cn("shrink-0", pad, "pb-2")}>
        <div
          className={cn(
            "flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border px-2 transition-colors focus-within:border-primary/60",
            fieldClass,
          )}
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setStatus(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (query !== "") clear();
                else searchRef.current?.blur();
              }
              if (event.key === "Enter" && names.length > 0) {
                onOpen(names[0].path);
              }
            }}
            placeholder={t("workspaceSearch.placeholder")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {busy && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          )}
          {query !== "" && (
            <Hint label={t("workspaceSearch.clear")}>
              <button
                type="button"
                onClick={clear}

                aria-label={t("workspaceSearch.clear")}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </Hint>
          )}
          {/* The three filters in a popover: the bar is narrow, and three
              permanent buttons stole width from the searched text itself. */}
          <Popover>
            <PopoverTrigger
              title={t("workspaceSearch.filters")}
              aria-label={t("workspaceSearch.filters")}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
                activeFilters > 0
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <ListFilterIcon className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              <FilterOption
                active={caseSensitive}
                icon={<CaseSensitiveIcon className="size-3.5" />}
                label={t("workspaceSearch.caseSensitive")}
                onToggle={() => setCaseSensitive((value) => !value)}
              />
              <FilterOption
                active={wholeWord}
                icon={<WholeWordIcon className="size-3.5" />}
                label={t("workspaceSearch.wholeWord")}
                onToggle={() => setWholeWord((value) => !value)}
              />
              <FilterOption
                active={regex}
                icon={<RegexIcon className="size-3.5" />}
                label={t("workspaceSearch.regex")}
                onToggle={() => setRegex((value) => !value)}
              />
            </PopoverContent>
          </Popover>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <Hint label={t("workspaceSearch.replaceToggle")}>
            <button
              type="button"
              onClick={() => setReplaceOpen((value) => !value)}

              aria-label={t("workspaceSearch.replaceToggle")}
              aria-expanded={replaceOpen}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
                replaceOpen
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <ChevronRightIcon
                className={cn("size-3.5 transition-transform", replaceOpen && "rotate-90")}
              />
            </button>
          </Hint>
        </div>
      </div>

      {/* Replace: the new field and the button the reach allows. */}
      {replaceOpen && (
        <div className={cn("shrink-0", pad, "pb-2")}>
          <div className="flex flex-col gap-1.5">
            <div
              className={cn(
                "flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border px-2 transition-colors focus-within:border-primary/60",
                fieldClass,
              )}
            >
              <ReplaceIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                placeholder={t("workspaceSearch.replaceWith")}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
              <IconToggle
                active={preserveCase}
                title={t("workspaceSearch.preserveCase")}
                onToggle={() => setPreserveCase((value) => !value)}
              >
                <ALargeSmallIcon className="size-3.5" />
              </IconToggle>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              {/* In the panel the list is the whole workspace — replacing "here" has
                  no here. The focused file only exists in the modal (⌘P). */}
              {variant === "dialog" && (
                <Hint label={canReplaceInFile
                      ? t("workspaceSearch.replaceInFileHint")
                      : t("workspaceSearch.replaceInFileDisabled")}>
                  <button
                    type="button"
                    onClick={replaceInFile}
                    disabled={!canReplaceInFile}
                    className="h-7 w-full rounded-md border border-border px-2 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
       
                           {t("workspaceSearch.replaceInFile")}
                </button>
                </Hint>
              )}
              <button
                type="button"
                onClick={replaceAll}
                disabled={!canReplaceAll || busy}
                className="h-7 w-full rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("workspaceSearch.replaceAll")}
              </button>
              {matches > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {t("workspaceSearch.occurrenceCount", {
                    count: matches,
                    files: occurrences.length,
                  })}
                </span>
              )}
            </div>
            {status && (
              <p className="text-[10px] leading-snug text-muted-foreground">{status}</p>
            )}
            {error && (
              <p className="break-words text-[10px] leading-snug text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      )}

      {invalidPattern && (
        <p className={cn("shrink-0 pb-1 text-[10px] text-destructive", pad)}>
          {t("workspaceSearch.invalidPattern")}
        </p>
      )}

      {children != null && trimmed === "" ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn("flex flex-col pb-2", pad, "pr-1")}>
            {nothingFound && (
              <p className="px-2 py-3 text-[11px] leading-snug text-muted-foreground">
                {t("workspaceSearch.empty")}
              </p>
            )}

            {/* Files — the group gets out of the way when one is replacing:
                the subject there is where the text appears, not file names. */}
            {showNames && trimmed !== "" && (
              <section className="flex flex-col">
                <GroupHead
                  open={namesOpen}
                  label={t("workspaceSearch.fileGroup")}
                  count={names.length}
                  onToggle={() => setNamesOpen((value) => !value)}
                />
                {namesOpen &&
                  names.map((row) => (
                    <button
                      key={row.path}
                      type="button"
                      onClick={() => onOpen(row.path)}
                      className="flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] hover:bg-accent"
                    >
                      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                      
                        <Truncate>
                            <span className="min-w-0 shrink truncate">{row.name}</span>
                        </Truncate>
                      
                        <Truncate>
                            <span className="ml-auto min-w-0 truncate text-[10px] text-muted-foreground">
                            {rootLabel && (
                              <span className="mr-1 text-foreground/50">
                                {rootLabel.get(row.root)}
                              </span>
                          )}
                          {row.dir}
                        </span>
                        </Truncate>
                    </button>
                  ))}
              </section>
            )}

            {/* Occurrences */}
            <section className="mt-1 flex flex-col">
              <GroupHead
                open={occurrencesOpen}
                label={t("workspaceSearch.occurrenceGroup")}
                count={matches}
                onToggle={() => setOccurrencesOpen((value) => !value)}
              />
              {occurrencesOpen &&
                occurrences.map((file) => {
                  const cut = file.rel.lastIndexOf("/");
                  const name = cut === -1 ? file.rel : file.rel.slice(cut + 1);
                  return (
                    <div key={file.path} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => onOpen(file.path)}
                        className="flex min-w-0 items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] font-medium hover:bg-accent"
                      >
                        <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                        
                          <Truncate>
                              <span className="min-w-0 shrink truncate">{name}</span>
                          </Truncate>
                        <span className="ml-auto shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[9.5px] tabular-nums text-muted-foreground">
                          {file.count}
                        </span>
                      </button>
                      {file.lines.map((line) => (
                        <button
                          key={`${file.path}:${line.line}:${line.column}`}
                          type="button"
                          onClick={() => onOpen(file.path, line.line)}
                          className="flex min-w-0 flex-col rounded px-2 py-0.5 pl-6 text-left hover:bg-accent"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="w-6 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground/70">
                              {line.line}
                            </span>
                            <CodeLine
                              text={line.text}
                              start={Math.max(0, line.column - 1)}
                              length={line.length}
                              tone="match"
                            />
                          </span>
                          {showPreview && (
                            <PreviewRow
                              hit={line}
                              replacement={replacement}
                              options={{ ...options, preserveCase }}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
            </section>

            {trimmed !== "" && scanned > 0 && occurrences.length > 0 && (
              <p className="px-2 pt-2 text-[10px] text-muted-foreground/70">
                {t("workspaceSearch.scanned", { count: scanned })}
              </p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
