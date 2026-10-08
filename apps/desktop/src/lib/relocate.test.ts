import { describe, expect, it } from "vitest"

import {
  collectFolderPaths,
  folderBaseName,
  missingFolders,
  relocateAutoFolderEntry,
  relocateSessionFolders,
  relocatedFolderName,
  sessionFolderPaths,
} from "@/src/lib/relocate"

/**
 * A revalidação de pastas é o que sobra quando o caminho é só uma string: o
 * usuário renomeia a pasta no Finder e as referências continuam apontando para
 * o vazio. O que se testa aqui é o julgamento — o que conta como sumido, o que
 * deve ser religado e o que NÃO deve ser tocado. Errar para o lado de mexer
 * demais é pior do que não mexer: os dados das sessões não têm backup.
 */

describe("folderBaseName", () => {
  it("devolve o último segmento do caminho", () => {
    expect(folderBaseName("/Users/me/Projects/meu-app")).toBe("meu-app")
  })

  it("tolera barra no fim e separador do Windows", () => {
    expect(folderBaseName("/Users/me/Projects/meu-app/")).toBe("meu-app")
    expect(folderBaseName("C:\\Users\\me\\meu-app")).toBe("meu-app")
  })
})

describe("sessionFolderPaths", () => {
  it("lista a principal antes das extras e ignora vazios", () => {
    expect(
      sessionFolderPaths({ directory: "/a", extraDirectories: ["/b", "/c"] }),
    ).toEqual(["/a", "/b", "/c"])
    expect(sessionFolderPaths({ extraDirectories: ["/b"] })).toEqual(["/b"])
    expect(sessionFolderPaths({})).toEqual([])
  })
})

describe("collectFolderPaths", () => {
  it("junta workspace e sessões sem repetir, preservando a ordem", () => {
    const sessions = [
      { directory: "/proj/a", extraDirectories: ["/proj/shared"] },
      { directory: "/proj/a" },
    ]
    expect(collectFolderPaths(["/proj/a", "/proj/b"], sessions)).toEqual([
      "/proj/a",
      "/proj/b",
      "/proj/shared",
    ])
  })

  it("ignora sessões sem pasta", () => {
    expect(collectFolderPaths(["/proj/a"], [{}, { extraDirectories: [] }])).toEqual(["/proj/a"])
  })
})

describe("missingFolders", () => {
  it("acusa só o que foi checado e não existe", () => {
    const existing = { "/viva": true, "/morta": false }
    expect(missingFolders(["/viva", "/morta", "/nao-checada"], existing)).toEqual([
      { path: "/morta", name: "morta" },
    ])
  })

  it("caminho não checado é dúvida, não ausência", () => {
    expect(missingFolders(["/sumiu"], {})).toEqual([])
  })
})

describe("relocateSessionFolders", () => {
  const session = { directory: "/antigo", extraDirectories: ["/outra", "/antigo"] }

  it("religa o diretório principal", () => {
    expect(relocateSessionFolders({ directory: "/antigo" }, "/antigo", "/novo")).toEqual({
      directory: "/novo",
    })
  })

  it("religa a pasta extra na posição em que estava", () => {
    expect(relocateSessionFolders(session, "/antigo", "/novo")).toEqual({
      directory: "/novo",
      extraDirectories: ["/outra", "/novo"],
    })
  })

  it("não toca em sessão que não referencia o caminho", () => {
    expect(relocateSessionFolders({ directory: "/outro" }, "/antigo", "/novo")).toBeNull()
  })

  it("não muda a sessão original", () => {
    const original = { directory: "/antigo", extraDirectories: ["/antigo"] }
    relocateSessionFolders(original, "/antigo", "/novo")
    expect(original).toEqual({ directory: "/antigo", extraDirectories: ["/antigo"] })
  })
})

describe("relocateAutoFolderEntry", () => {
  it("move a entrada para o caminho novo", () => {
    expect(relocateAutoFolderEntry({ "/antigo": "f1" }, "/antigo", "/novo")).toEqual({
      "/novo": "f1",
    })
  })

  it("não rouba o dono quando o destino já tem pasta", () => {
    expect(
      relocateAutoFolderEntry({ "/antigo": "f1", "/novo": "f2" }, "/antigo", "/novo"),
    ).toEqual({ "/novo": "f2" })
  })

  it("devolve null quando não havia entrada", () => {
    expect(relocateAutoFolderEntry({ "/outro": "f1" }, "/antigo", "/novo")).toBeNull()
  })
})

describe("relocatedFolderName", () => {
  it("segue o nome do projeto quando o nome ainda é o derivado", () => {
    expect(relocatedFolderName("Meu App", "/x/meu-app", "/y/app-novo")).toBe("App Novo")
  })

  it("não toca em nome editado à mão", () => {
    expect(relocatedFolderName("Cliente X", "/x/meu-app", "/y/app-novo")).toBeNull()
  })

  it("não devolve nada quando o nome não mudaria", () => {
    expect(relocatedFolderName("Meu App", "/x/meu-app", "/y/meu-app")).toBeNull()
  })
})
