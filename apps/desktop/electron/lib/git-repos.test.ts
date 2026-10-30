import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverGitRepos, discoverWorkspaceRepos } from "./git-repos";

const base = path.join(os.tmpdir(), `orbit-git-repos-${Date.now()}`);

/** Creates a folder with `.git` inside (enough for the discovery). */
async function mkRepo(dir: string, gitAsFile = false) {
  await fsp.mkdir(dir, { recursive: true });
  const git = path.join(dir, ".git");
  if (gitAsFile) await fsp.writeFile(git, "gitdir: /some/where\n");
  else await fsp.mkdir(git, { recursive: true });
}

afterAll(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

describe("discoverGitRepos", () => {
  it("finds the repos in the subfolders when the root has no git", async () => {
    const ws = path.join(base, "workspace");
    await mkRepo(path.join(ws, "front"));
    await mkRepo(path.join(ws, "back"));
    await fsp.mkdir(path.join(ws, "docs"), { recursive: true });

    const repos = await discoverGitRepos(ws);
    // Alphabetical order, stable — and not the one the disk returned.
    expect(repos.map((r) => r.name)).toEqual(["back", "front"]);
    expect(repos.map((r) => r.relative)).toEqual(["back", "front"]);
  });

  it("includes the root when it is a repo, along with the nested ones", async () => {
    const mono = path.join(base, "monorepo");
    await mkRepo(mono);
    await mkRepo(path.join(mono, "front"));

    const repos = await discoverGitRepos(mono);
    expect(repos.map((r) => r.name)).toEqual(["monorepo", "front"]);
    expect(repos[0].relative).toBe("");
  });

  it("goes down one level when neither the root nor the children have git", async () => {
    const umbrella = path.join(base, "umbrella");
    await mkRepo(path.join(umbrella, "project", "app"));

    const repos = await discoverGitRepos(umbrella);
    expect(repos.map((r) => r.name)).toEqual(["app"]);
    expect(repos[0].relative).toBe("project/app");
  });

  it("counts worktree and submodule, where .git is a file", async () => {
    const ws = path.join(base, "worktrees");
    await mkRepo(path.join(ws, "wt"), true);

    const repos = await discoverGitRepos(ws);
    expect(repos.map((r) => r.name)).toEqual(["wt"]);
  });

  it("ignores node_modules and hidden folders", async () => {
    const ws = path.join(base, "noise");
    await mkRepo(path.join(ws, "node_modules", "pacote"));
    await mkRepo(path.join(ws, ".cache", "escondido"));
    await mkRepo(path.join(ws, "real"));

    const repos = await discoverGitRepos(ws);
    expect(repos.map((r) => r.name)).toEqual(["real"]);
  });

  it("returns an empty list when there is no repo at all", async () => {
    const ws = path.join(base, "empty");
    await fsp.mkdir(path.join(ws, "a", "b"), { recursive: true });
    expect(await discoverGitRepos(ws)).toEqual([]);
  });
});

describe("discoverWorkspaceRepos", () => {
  it("adds the main folder with the folders attached to the chat", async () => {
    const main = path.join(base, "espaco");
    await mkRepo(path.join(main, "front"));
    const extra = path.join(base, "attached");
    await mkRepo(extra);

    const repos = await discoverWorkspaceRepos([main, extra]);
    expect(repos.map((r) => r.name)).toEqual(["front", "attached"]);
    // The attached folder's repo is readable by its name.
    expect(repos.map((r) => r.relative)).toEqual(["front", "attached"]);
  });

  it("prefixes the nested repo with the name of the attached folder", async () => {
    const main = path.join(base, "espaco2");
    await fsp.mkdir(path.join(main, "docs"), { recursive: true });
    const extra = path.join(base, "estudio");
    await mkRepo(path.join(extra, "api"));

    const repos = await discoverWorkspaceRepos([main, extra]);
    expect(repos.map((r) => r.name)).toEqual(["api"]);
    expect(repos[0].relative).toBe("estudio/api");
  });

  it("does not repeat the repo of an attached folder that is inside the main one", async () => {
    const main = path.join(base, "espaco3");
    await mkRepo(main);
    const extra = path.join(main, "app");
    await mkRepo(extra);

    const repos = await discoverWorkspaceRepos([main, extra]);
    expect(repos.map((r) => r.path)).toEqual([main, extra]);
    // The label stays being the path from the main one.
    expect(repos.map((r) => r.relative)).toEqual(["", "app"]);
  });

  it("returns an empty list when no folder has a repo", async () => {
    const main = path.join(base, "no-git");
    const extra = path.join(base, "no-git-2");
    await fsp.mkdir(main, { recursive: true });
    await fsp.mkdir(extra, { recursive: true });
    expect(await discoverWorkspaceRepos([main, extra])).toEqual([]);
    expect(await discoverWorkspaceRepos([])).toEqual([]);
  });
});
