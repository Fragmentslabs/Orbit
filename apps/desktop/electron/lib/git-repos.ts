import fsp from "node:fs/promises";
import path from "node:path";

/** Um repositório git encontrado dentro de uma pasta de trabalho. */
export interface GitRepoEntry {
  /** Caminho absoluto do repositório. */
  path: string;
  /** Rótulo curto: o nome da pasta. */
  name: string;
  /**
   * Caminho visível até o repo: relativo à pasta principal quando ele está
   * dentro dela; fora dela, prefixado com o nome da pasta anexada em que vive
   * (`outro-projeto/api`). "" quando é a própria pasta principal.
   */
  relative: string;
}

/** Teto de segurança: um espaço com dezenas de repos não vira uma lista infinita. */
const MAX_REPOS = 12;
/** Teto do conjunto: várias pastas anexadas somam, e o total também tem limite. */
const MAX_WORKSPACE_REPOS = 24;

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

/** Caminho normalizado para comparar: sem barra final e sempre com '/'. */
function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

/** `dir` está dentro de `root` — ou é ele mesmo? */
function isInside(root: string, dir: string): boolean {
  const base = normalizePath(root);
  const target = normalizePath(dir);
  return target === base || target.startsWith(`${base}/`);
}

/** Caminho de `dir` a partir de `root` ("" quando são a mesma pasta). */
function relativeTo(root: string, dir: string): string {
  const base = normalizePath(root);
  const target = normalizePath(dir);
  if (target === base) return "";
  return target.slice(base.length + 1);
}

/**
 * Descobre os repositórios de TODAS as pastas de trabalho do chat — a principal
 * e as anexadas.
 *
 * A primeira pasta é a principal e dá o vocabulário dos rótulos: um repo dentro
 * dela tem o caminho relativo a ela, como sempre teve. Um repo que vive numa
 * pasta anexada, fora da principal, ganha o nome dessa pasta como prefixo
 * (`outro/api`) — é o que desfaz a dúvida de qual "api" é este quando duas
 * pastas anexadas têm um. O caminho absoluto continua sendo a identidade.
 *
 * Repo que já apareceu numa pasta anterior não volta: uma pasta anexada que
 * esteja dentro da principal é encontrada pela varredura da principal, e o
 * rótulo dela fica o de lá.
 *
 * Lista vazia significa "nenhum repo em pasta nenhuma" — e aí o painel segue
 * como sempre foi, falando com a pasta principal.
 */
export async function discoverWorkspaceRepos(
  roots: string[],
): Promise<GitRepoEntry[]> {
  const unique: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const key = normalizePath(root);
    if (unique.some((r) => normalizePath(r) === key)) continue;
    unique.push(root);
  }
  if (unique.length === 0) return [];

  const main = unique[0];
  const found: GitRepoEntry[] = [];
  const seen = new Set<string>();

  for (const root of unique) {
    if (found.length >= MAX_WORKSPACE_REPOS) break;
    for (const repo of await discoverGitRepos(root)) {
      if (found.length >= MAX_WORKSPACE_REPOS) break;
      const key = normalizePath(repo.path);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        ...repo,
        // Dentro da principal o caminho já é relativo a ela; fora, o nome da
        // pasta anexada é o que dá um caminho legível.
        relative: isInside(main, repo.path)
          ? relativeTo(main, repo.path)
          : [path.basename(normalizePath(root)), repo.relative]
              .filter(Boolean)
              .join("/"),
      });
    }
  }

  return found;
}
