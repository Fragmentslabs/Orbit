import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  CaseSensitiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ListFilterIcon,
  RegexIcon,
  ReplaceIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  CodeEditorHandle,
  SearchReplaceOptions,
} from "@/src/components/code-editor";
import { buildMatcher } from "@/src/lib/text-match";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

export interface FileFindBarProps {
  /** The editor of the open file — the bar only asks; it is the one that matches. */
  editor: RefObject<CodeEditorHandle>;
  onClose: () => void;
}

/**
 * Search INSIDE the open file (Cmd+F).
 *
 * It replaces the `@codemirror/search` panel, which opened with the lib's labels
 * in English ("Find", "match case", "by word") and white boxes — a foreign
 * body inside the app. Here the grammar is the same as the field of the files
 * tab: a single outline, the filters in a popover and the replace behind the
 * chevron. What matches the text is the editor (`find`/`replaceMatch`), so the bar
 * does not have a second opinion about where the occurrences are.
 */
export function FileFindBar({ editor, onClose }: FileFindBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [preserveCase, setPreserveCase] = useState(true);
  const [found, setFound] = useState({ total: 0, index: 0 });

  const options = useMemo<SearchReplaceOptions>(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  /** An expression that does not compile is not "zero results" — it is a syntax error. */
  const invalid = useMemo(
    () => query !== "" && buildMatcher(query, options) === null,
    [query, options],
  );

  // Cmd+F has to land on the field: opening the bar and leaving the focus in the text is
  // no use at all.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // New query: it marks everything and jumps to the first occurrence from the
  // cursor. Without the jump, the count would say "12" without showing where they are.
  useEffect(() => {
    const handle = editor.current;
    if (!handle) return;
    handle.highlightQuery(query, options);
    setFound(
      query === "" ? { total: 0, index: 0 } : handle.find(query, options, "start"),
    );
  }, [query, options, editor]);

  // Closing the bar gives the file back without marks.
  useEffect(() => () => editor.current?.highlightQuery(""), [editor]);

  const activeFilters =
    Number(caseSensitive) + Number(wholeWord) + Number(regex);

  const step = (direction: "next" | "prev") => {
    if (query === "" || invalid) return;
    setFound(
      editor.current?.find(query, options, direction) ?? { total: 0, index: 0 },
    );
  };

  const replaceOne = () => {
    const handle = editor.current;
    if (!handle) return;
    if (!handle.replaceMatch(query, replacement, { ...options, preserveCase })) {
      return;
    }
    setFound(handle.find(query, options, "next"));
  };

  const replaceEvery = () => {
    const handle = editor.current;
    if (!handle) return;
    handle.replaceAll(query, replacement, { ...options, preserveCase });
    setFound(handle.find(query, options, "start"));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? "prev" : "next");
    }
  };

  const countLabel = invalid
    ? t("workspaceSearch.invalidPattern")
    : found.total === 0
      ? t("fileFind.noResults")
      : `${found.index}/${found.total}`;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-background px-2 py-1.5"
      onKeyDown={onKeyDown}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-transparent px-2 transition-colors focus-within:border-primary/60">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("fileFind.placeholder")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query !== "" && (
            <span
              className={cn(
                "shrink-0 text-[10px] tabular-nums",
                found.total === 0 || invalid
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {countLabel}
            </span>
          )}
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
                "flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent",
                replaceOpen
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", !replaceOpen && "-rotate-90")}
              />
            </button>
          </Hint>
        </div>
        <Hint label={t("fileFind.previous")}>
          <button
            type="button"
            onClick={() => step("prev")}
            disabled={found.total === 0}

            aria-label={t("fileFind.previous")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
        </Hint>
        <Hint label={t("fileFind.next")}>
          <button
            type="button"
            onClick={() => step("next")}
            disabled={found.total === 0}

            aria-label={t("fileFind.next")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </Hint>
        <Hint label={t("fileFind.close")}>
          <button
            type="button"
            onClick={onClose}

            aria-label={t("fileFind.close")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </Hint>
      </div>
      {replaceOpen && (
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-transparent px-2 transition-colors focus-within:border-primary/60">
            <ReplaceIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder={t("fileFind.replacePlaceholder")}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => setPreserveCase((value) => !value)}
              aria-label={t("workspaceSearch.preserveCase")}
              aria-pressed={preserveCase}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold transition-colors",
                preserveCase
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              Aa
            </button>
          </div>
          <button
            type="button"
            onClick={replaceOne}
            disabled={found.total === 0}
            className="h-8 shrink-0 rounded-md border border-border px-2 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("fileFind.replace")}
          </button>
          <button
            type="button"
            onClick={replaceEvery}
            disabled={found.total === 0}
            className="h-8 shrink-0 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("fileFind.replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Option of the filters popover — it does not close on click: the filters combine. */
function FilterOption({
  active,
  icon,
  label,
  onToggle,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
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
