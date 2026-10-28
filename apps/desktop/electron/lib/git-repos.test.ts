import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverGitRepos, discoverWorkspaceRepos } from "./git-repos";

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

describe("discoverWorkspaceRepos", () => {
  it("soma a pasta principal com as pastas anexadas ao chat", async () => {
    const main = path.join(base, "espaco");
    await mkRepo(path.join(main, "front"));
    const extra = path.join(base, "anexada");
    await mkRepo(extra);

    const repos = await discoverWorkspaceRepos([main, extra]);
    expect(repos.map((r) => r.name)).toEqual(["front", "anexada"]);
    // O repo da pasta anexada é legível pelo nome dela.
    expect(repos.map((r) => r.relative)).toEqual(["front", "anexada"]);
  });

  it("prefixa o repo aninhado com o nome da pasta anexada", async () => {
    const main = path.join(base, "espaco2");
    await fsp.mkdir(path.join(main, "docs"), { recursive: true });
    const extra = path.join(base, "estudio");
    await mkRepo(path.join(extra, "api"));

    const repos = await discoverWorkspaceRepos([main, extra]);
    expect(repos.map((r) => r.name)).toEqual(["api"]);
    expect(repos[0].relative).toBe("estudio/api");
  });

  it("não repete o repo de uma pasta anexada que está dentro da principal", async () => {
    const main = path.join(base, "espaco3");
    await mkRepo(main);
    const extra = path.join(main, "app");
    await mkRepo(extra);

    const repos = await discoverWorkspaceRepos([main, extra]);
    expect(repos.map((r) => r.path)).toEqual([main, extra]);
    // O rótulo continua sendo o caminho a partir da principal.
    expect(repos.map((r) => r.relative)).toEqual(["", "app"]);
  });

  it("devolve lista vazia quando nenhuma pasta tem repo", async () => {
    const main = path.join(base, "sem-git");
    const extra = path.join(base, "sem-git-2");
    await fsp.mkdir(main, { recursive: true });
    await fsp.mkdir(extra, { recursive: true });
    expect(await discoverWorkspaceRepos([main, extra])).toEqual([]);
    expect(await discoverWorkspaceRepos([])).toEqual([]);
  });
});
