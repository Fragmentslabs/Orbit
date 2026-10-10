import fsp from "node:fs/promises";
import path from "node:path";

/** Um repositório git encontrado dentro de uma pasta de trabalho. */
export interface GitRepoEntry {
  /** Caminho absoluto do repositório. */
  path: string;
  /** Rótulo curto: o nome da pasta. */
  name: string;
  /** Caminho relativo à pasta de trabalho ("" quando é a própria pasta). */
  relative: string;
}

/** Teto de segurança: um espaço com dezenas de repos não vira uma lista infinita. */
const MAX_REPOS = 12;

/** Pastas que nunca valem uma varredura. */
const SKIP = new Set(["node_modules", "vendor"]);

async function hasGit(dir: string): Promise<boolean> {
  // `.git` é pasta no repo normal e ARQUIVO em worktree e submódulo: existir já basta.
  try {
    await fsp.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return (
      entries
        .filter(
          (e) =>
            e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name),
        )
        .map((e) => path.join(dir, e.name))
        // Ordem estável: a lista do painel não pode depender de como o disco
        // devolveu as pastas.
        .sort((a, b) => a.localeCompare(b))
    );
  } catch {
    // Pasta ilegível (permissão, sumiu no meio): não é motivo para falhar a descoberta.
    return [];
  }
}

/**
 * Descobre os repositórios que vivem numa pasta de trabalho.
 *
 * A própria pasta entra quando é repo; depois as subpastas com git próprio — o
 * caso de um espaço com `front/` e `back/`, cada um com o seu. Sem nenhum nesses
 * dois níveis, desce mais um: pasta guarda-chuva que só guarda projetos, onde o
 * repo fica em `projeto/alguma-coisa`.
 *
 * Lista vazia significa "nenhum repo aqui" — e aí o painel segue como sempre
 * foi, falando com a pasta raiz.
 */
export async function discoverGitRepos(root: string): Promise<GitRepoEntry[]> {
  const found: GitRepoEntry[] = [];

  const add = (dir: string) => {
    if (found.length >= MAX_REPOS || found.some((r) => r.path === dir)) return;
    found.push({
      path: dir,
      name: path.basename(dir) || dir,
      relative: path.relative(root, dir).split(path.sep).join("/"),
    });
  };

  if (await hasGit(root)) add(root);

  const level1 = await subdirs(root);
  for (const dir of level1) {
    if (await hasGit(dir)) add(dir);
  }

  if (found.length === 0) {
    for (const dir of level1) {
      for (const deeper of await subdirs(dir)) {
        if (await hasGit(deeper)) add(deeper);
      }
    }
  }

  return found;
}
