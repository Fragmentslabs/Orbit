import { describe, expect, it } from "vitest"

import {
  folderForPath,
  groupByFolder,
  repoForPath,
  type GitRepoEntry,
} from "@/src/lib/folders"

/**
 * O dono de um caminho decide para onde vão o seletor de branch, o puxar/enviar
 * e a lente de diff. O caso que importa é o da pasta raiz que TAMBÉM é repo: o
 * caminho dela é prefixo de todo repo aninhado, e ficar com o primeiro que casa
 * mandaria um arquivo do `front/` para o repositório de cima.
 */

const repo = (path: string, name: string, relative: string): GitRepoEntry => ({
  path,
  name,
  relative,
})

const raizERepo = [
  repo("/ws", "ws", ""),
  repo("/ws/front", "front", "front"),
  repo("/ws/back", "back", "back"),
]

describe("repoForPath", () => {
  it("prefere o repo mais fundo quando a raiz também é repo", () => {
    expect(repoForPath(raizERepo, "/ws/front/src/app.tsx")).toBe("/ws/front")
    expect(repoForPath(raizERepo, "/ws/back/api/index.ts")).toBe("/ws/back")
  })

  it("devolve a raiz para o que não está em repo aninhado", () => {
    expect(repoForPath(raizERepo, "/ws/README.md")).toBe("/ws")
  })

  it("devolve null quando nenhum repo contém o caminho", () => {
    expect(repoForPath(raizERepo, "/outro/lugar/x.ts")).toBeNull()
    expect(repoForPath([], "/ws/front/x.ts")).toBeNull()
  })

  it("não confunde pasta irmã de nome parecido", () => {
    // `/ws/frontend` não é `/ws/front` — o separador é que fecha o prefixo.
    expect(repoForPath(raizERepo, "/ws/frontend/x.ts")).toBe("/ws")
  })

  it("casa caminho com separador do Windows", () => {
    const repos = [repo("C:\\ws", "ws", ""), repo("C:\\ws\\front", "front", "front")]
    expect(repoForPath(repos, "C:\\ws\\front\\src\\a.ts")).toBe("C:\\ws\\front")
  })
})

/**
 * A lista de alterações mostra as pastas do chat — a principal e as anexadas.
 * O arquivo tem de aparecer debaixo da pasta dele, uma vez só.
 */

describe("folderForPath", () => {
  const pastas = ["/ws", "/ws/app", "/outro"]

  it("prefere a pasta mais funda quando uma está dentro da outra", () => {
    expect(folderForPath(pastas, "/ws/app/src/x.ts")).toBe("/ws/app")
    expect(folderForPath(pastas, "/ws/README.md")).toBe("/ws")
  })

  it("devolve null quando o arquivo não está em pasta nenhuma", () => {
    expect(folderForPath(pastas, "/fora/x.ts")).toBeNull()
    expect(folderForPath([], "/ws/x.ts")).toBeNull()
  })
})

describe("groupByFolder", () => {
  const arquivo = (path: string) => ({ path })

  it("separa as mudanças por pasta, na ordem das pastas", () => {
    const grupos = groupByFolder(
      ["/ws", "/outro"],
      [arquivo("/outro/src/b.ts"), arquivo("/ws/src/a.ts")],
      "/ws",
    )
    expect(grupos.map((g) => g.folder)).toEqual(["/ws", "/outro"])
    expect(grupos[0].files.map((f) => f.path)).toEqual(["/ws/src/a.ts"])
    expect(grupos[1].files.map((f) => f.path)).toEqual(["/outro/src/b.ts"])
  })

  it("conta o arquivo uma vez só, na pasta mais específica", () => {
    const grupos = groupByFolder(
      ["/ws", "/ws/app"],
      [arquivo("/ws/app/src/x.ts"), arquivo("/ws/README.md")],
      "/ws",
    )
    expect(grupos.map((g) => g.folder)).toEqual(["/ws", "/ws/app"])
    expect(
      grupos.find((g) => g.folder === "/ws")!.files.map((f) => f.path),
    ).toEqual(["/ws/README.md"])
    expect(
      grupos.find((g) => g.folder === "/ws/app")!.files.map((f) => f.path),
    ).toEqual(["/ws/app/src/x.ts"])
  })

  it("põe no fallback o arquivo que não está em pasta nenhuma", () => {
    // Troca de pastas: o status é de um instante atrás e o arquivo não pode
    // sumir da lista por causa disso.
    const grupos = groupByFolder(["/ws"], [arquivo("/sumiu/x.ts")], "/ws")
    expect(grupos).toHaveLength(1)
    expect(grupos[0].folder).toBe("/ws")
    expect(grupos[0].files).toHaveLength(1)
  })
})
