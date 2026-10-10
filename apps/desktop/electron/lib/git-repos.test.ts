import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverGitRepos } from "./git-repos";

const base = path.join(os.tmpdir(), `orbit-git-repos-${Date.now()}`);

/** Cria uma pasta com `.git` dentro (o suficiente para a descoberta). */
async function mkRepo(dir: string, gitAsFile = false) {
  await fsp.mkdir(dir, { recursive: true });
  const git = path.join(dir, ".git");
  if (gitAsFile) await fsp.writeFile(git, "gitdir: /algum/lugar\n");
  else await fsp.mkdir(git, { recursive: true });
}

afterAll(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

describe("discoverGitRepos", () => {
  it("acha os repos das subpastas quando a raiz não tem git", async () => {
    const ws = path.join(base, "workspace");
    await mkRepo(path.join(ws, "front"));
    await mkRepo(path.join(ws, "back"));
    await fsp.mkdir(path.join(ws, "docs"), { recursive: true });

    const repos = await discoverGitRepos(ws);
    // Ordem alfabética, estável — e não a que o disco devolveu.
    expect(repos.map((r) => r.name)).toEqual(["back", "front"]);
    expect(repos.map((r) => r.relative)).toEqual(["back", "front"]);
  });

  it("inclui a raiz quando ela é repo, junto com os aninhados", async () => {
    const mono = path.join(base, "monorepo");
    await mkRepo(mono);
    await mkRepo(path.join(mono, "front"));

    const repos = await discoverGitRepos(mono);
    expect(repos.map((r) => r.name)).toEqual(["monorepo", "front"]);
    expect(repos[0].relative).toBe("");
  });

  it("desce um nível quando nem a raiz nem os filhos têm git", async () => {
    const umbrella = path.join(base, "guarda-chuva");
    await mkRepo(path.join(umbrella, "projeto", "app"));

    const repos = await discoverGitRepos(umbrella);
    expect(repos.map((r) => r.name)).toEqual(["app"]);
    expect(repos[0].relative).toBe("projeto/app");
  });

  it("conta worktree e submódulo, onde .git é arquivo", async () => {
    const ws = path.join(base, "worktrees");
    await mkRepo(path.join(ws, "wt"), true);

    const repos = await discoverGitRepos(ws);
    expect(repos.map((r) => r.name)).toEqual(["wt"]);
  });

  it("ignora node_modules e pastas ocultas", async () => {
    const ws = path.join(base, "ruido");
    await mkRepo(path.join(ws, "node_modules", "pacote"));
    await mkRepo(path.join(ws, ".cache", "escondido"));
    await mkRepo(path.join(ws, "real"));

    const repos = await discoverGitRepos(ws);
    expect(repos.map((r) => r.name)).toEqual(["real"]);
  });

  it("devolve lista vazia quando não há repo nenhum", async () => {
    const ws = path.join(base, "vazio");
    await fsp.mkdir(path.join(ws, "a", "b"), { recursive: true });
    expect(await discoverGitRepos(ws)).toEqual([]);
  });
});
