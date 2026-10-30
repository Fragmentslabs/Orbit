import { useEffect, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { highlightLines, type HighlightedToken } from "@/lib/code-highlighter";
import type { FileDiff } from "@/lib/unified-diff";
import { cn } from "@/lib/utils";

/**
 * Renders the hunks of a diff file with syntax highlighting: the added/removed
 * lines keep the language colors and only the background changes
 * (green/red). Used by the file viewer of the Folders and by the
 * Diff tab.
 */

/** Rebuilds the content of one side of the diff (old = ctx + del, new = ctx + add). */
function rebuildContent(file: FileDiff, side: "old" | "new"): string {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "ctx") {
        lines.push(line.text);
      } else if (side === "new" ? line.kind === "add" : line.kind === "del") {
        lines.push(line.text);
      }
    }
  }
  return lines.join("\n");
}

interface FileTokens {
  oldTokens: HighlightedToken[][] | null;
  newTokens: HighlightedToken[][] | null;
}

/** Highlights both sides of the file; returns null until the highlighting is done. */
function useFileTokens(
  file: FileDiff,
  filePath: string | undefined,
  theme: "dark" | "light",
): FileTokens | null {
  const path =
    filePath ?? (file.newPath === "/dev/null" ? file.oldPath : file.newPath);
  const [tokens, setTokens] = useState<FileTokens | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    void Promise.all([
      highlightLines(rebuildContent(file, "old"), path, theme),
      highlightLines(rebuildContent(file, "new"), path, theme),
    ]).then(([oldTokens, newTokens]) => {
      if (!cancelled) setTokens({ oldTokens, newTokens });
    });
    return () => {
      cancelled = true;
    };
  }, [file, path, theme]);

  return tokens;
}

export function HighlightedDiffFile({
  file,
  filePath,
  wrap = false,
  stickyHeader = true,
}: {
  file: FileDiff;
  /** Path used to detect the language (default: new path of the file). */
  filePath?: string;
  /** Wraps long lines instead of horizontal scrolling. */
  wrap?: boolean;
  /** Keeps the hunk header stuck at the top during the scroll. */
  stickyHeader?: boolean;
}) {
  const { theme } = useTheme();
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const tokens = useFileTokens(file, filePath, isDark ? "dark" : "light");

  return (
    <>
      {file.hunks.map((hunk, hi) => {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        let oldIdx = 0;
        let newIdx = 0;
        return (
          <div key={hi} className="min-w-0 border-b border-border/40 last:border-b-0">
            <div
              className={cn(
                "px-4 py-1 text-[11px] text-muted-foreground",
                stickyHeader ? "sticky top-0 z-10 bg-accent/50" : "bg-accent/30",
              )}
            >
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}
              @@{hunk.header ? ` ${hunk.header}` : ""}
            </div>
            {hunk.lines.map((line, li) => {
              const lineNum =
                line.kind === "add"
                  ? `  ${newLine}`
                  : line.kind === "del"
                    ? `${oldLine}  `
                    : `${oldLine} →${newLine}`;
              // Tokens of the line, indexed by the order in the rebuilt content
              // (the order of the hunks is sequential, so the index matches).
              let lineTokens: HighlightedToken[] | null | undefined;
              if (line.kind === "del") {
                lineTokens = tokens?.oldTokens?.[oldIdx];
                oldIdx++;
              } else if (line.kind === "add") {
                lineTokens = tokens?.newTokens?.[newIdx];
                newIdx++;
              } else {
                lineTokens = tokens?.oldTokens?.[oldIdx];
                oldIdx++;
                newIdx++;
              }
              if (line.kind !== "del") newLine++;
              if (line.kind !== "add") oldLine++;
              return (
                <div
                  key={li}
                  className={cn(
                    "flex min-w-0 px-4 leading-5",
                    !wrap && "whitespace-pre",
                    line.kind === "add" && "bg-emerald-500/10",
                    line.kind === "del" && "bg-red-500/10",
                  )}
                >
                  <span className="w-14 shrink-0 select-none text-right text-[10px] text-muted-foreground/40 tabular-nums">
                    {lineNum}
                  </span>
                  <span className="w-4 shrink-0 select-none text-center text-muted-foreground/50">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      wrap && "whitespace-pre-wrap break-all",
                    )}
                  >
                    {lineTokens
                      ? lineTokens.length === 0
                        ? "\u00a0"
                        : lineTokens.map((tok, j) => (
                            <span key={j} style={{ color: tok.color }}>
                              {tok.content}
                            </span>
                          ))
                      : line.text || " "}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}