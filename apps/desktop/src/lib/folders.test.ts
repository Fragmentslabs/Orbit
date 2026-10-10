import { describe, expect, it } from "vitest"

import { repoForPath, type GitRepoEntry } from "@/src/lib/folders"

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
