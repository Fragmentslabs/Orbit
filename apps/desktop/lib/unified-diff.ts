/**
 * Parser de unified diff (saída de `git diff` / `git show`).
 * Compartilhado entre a aba Diff e o visualizador de arquivos das Pastas:
 * ambos renderizam o mesmo modelo de hunks com linhas adicionadas (verde) e
 * removidas (vermelho).
 */

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: Array<{ kind: "add" | "del" | "ctx"; text: string }>;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
  added: number;
  removed: number;
}

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const fileBlocks = patch.split(/(?=^diff --git )/m);

  for (const block of fileBlocks) {
    if (!block.trim()) continue;
    const headerMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];
    const hunks: Hunk[] = [];
    let added = 0;
    let removed = 0;

    const hunkBlocks = block.split(/(?=^@@ )/m);
    for (const hunkBlock of hunkBlocks) {
      const hunkMatch = hunkBlock.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.+)?$/m);
      if (!hunkMatch) continue;

      const oldStart = Number(hunkMatch[1]);
      const oldLines = Number(hunkMatch[2] || 1);
      const newStart = Number(hunkMatch[3]);
      const newLines = Number(hunkMatch[4] || 1);
      const header = (hunkMatch[5] ?? "").trim();

      const lines: Hunk["lines"] = [];
      const bodyLines = hunkBlock.split("\n").slice(1); // skip @@ line
      // O split do corpo deixa um "" fantasma no fim (o \n final do patch):
      // não é uma linha do arquivo, só desalinha números e índices.
      if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
        bodyLines.pop();
      }
      for (const raw of bodyLines) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("+")) {
          lines.push({ kind: "add", text: line.slice(1) });
          added++;
        } else if (line.startsWith("-")) {
          lines.push({ kind: "del", text: line.slice(1) });
          removed++;
        } else {
          lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
        }
      }

      hunks.push({ oldStart, oldLines, newStart, newLines, header, lines });
    }

    files.push({ oldPath, newPath, hunks, added, removed });
  }

  return files;
}
