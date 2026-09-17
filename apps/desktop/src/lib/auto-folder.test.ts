import { describe, expect, it } from "vitest"
import type { FolderInfo } from "@shared/chat"
import { planAutoFolder } from "./auto-folder"

/**
 * "Criar pastas automaticamente" parou de funcionar por projeto, não por app.
 *
 * O mapa diretório → pasta guarda o que aconteceu da última vez. O que
 * aconteceu DESDE ENTÃO — a pasta foi arquivada, apagada — ele não sabe. E o
 * ramo que lidava com isso não fazia nada: a sessão nascia solta, o mapa
 * continuava apontando para a mesma pasta, e a próxima sessão caía no mesmo
 * lugar. Arquivar a pasta de um projeto desligava a criação automática DELE
 * para sempre, com a preferência ligada o tempo todo.
 *
 * Os testes abaixo são os estados em que o mapa pode estar quando a sessão
 * nasce.
 */

const ORBIT: FolderInfo = {
  id: "f-orbit",
  name: "Orbit",
  mode: "code",
  pinned: false,
  archived: false,
  createdAt: 1,
}

const folder = (over: Partial<FolderInfo>): FolderInfo => ({ ...ORBIT, ...over })

describe("pasta automática do projeto", () => {
  it("usa a pasta que o mapa aponta", () => {
    expect(
      planAutoFolder({
        directory: "C:/Projects/Orbit",
        mode: "code",
        folders: [ORBIT],
        mappedId: "f-orbit",
      }),
    ).toEqual({ folderId: "f-orbit" })
  })

  it("pasta ARQUIVADA volta para a sidebar em vez de virar beco sem saída", () => {
    // Este é o bug. Antes, a sessão nascia solta e o mapa continuava apontando
    // para a arquivada — todo chat novo daquele projeto nascia solto também.
    const arquivada = folder({ id: "f-vlk", name: "Vlk go", archived: true })
    expect(
      planAutoFolder({
        directory: "C:/Projects/Vlk - GO",
        mode: "code",
        folders: [arquivada],
        mappedId: "f-vlk",
      }),
    ).toEqual({ folderId: "f-vlk", revive: true })
  })

  it("mapa apontando para pasta apagada cai na busca por nome", () => {
    expect(
      planAutoFolder({
        directory: "C:/Projects/Orbit",
        mode: "code",
        folders: [ORBIT],
        mappedId: "f-que-nao-existe-mais",
      }),
    ).toEqual({ folderId: "f-orbit" })
  })

  it("mapa apontando para pasta de OUTRO modo não vale", () => {
    // Os ids são de espaços diferentes; uma pasta de chat não recebe sessão de
    // código. Antes isso também caía no ramo que não fazia nada.
    const dePastaDeChat = folder({ id: "f-chat", mode: "chat" })
    expect(
      planAutoFolder({
        directory: "C:/Projects/Orbit",
        mode: "code",
        folders: [dePastaDeChat],
        mappedId: "f-chat",
      }),
    ).toEqual({ create: "Orbit" })
  })

  it("sem mapa, reconhece o projeto pelo nome — inclusive com o caminho diferente", () => {
    // Mapa perdido (localStorage limpo, máquina nova) ou o mesmo projeto aberto
    // por outro caminho. Sem isto, nasceria uma segunda pasta "Orbit".
    for (const dir of ["C:/Projects/Orbit", "C:\\Projects\\Orbit\\", "~/projects/orbit"]) {
      expect(planAutoFolder({ directory: dir, mode: "code", folders: [ORBIT] })).toEqual({
        folderId: "f-orbit",
      })
    }
  })

  it("prefere a pasta viva quando existe uma arquivada com o mesmo nome", () => {
    const viva = folder({ id: "f-viva" })
    const velha = folder({ id: "f-velha", archived: true })
    expect(
      planAutoFolder({ directory: "C:/Projects/Orbit", mode: "code", folders: [velha, viva] }),
    ).toEqual({ folderId: "f-viva" })
  })

  it("com só a arquivada, revive em vez de criar uma duplicata ao lado", () => {
    const velha = folder({ id: "f-velha", archived: true })
    expect(
      planAutoFolder({ directory: "C:/Projects/Orbit", mode: "code", folders: [velha] }),
    ).toEqual({ folderId: "f-velha", revive: true })
  })

  it("projeto novo ganha pasta com o nome legível do diretório", () => {
    expect(
      planAutoFolder({
        directory: "C:/Projects/WWO/irrigaboi-app-montadores",
        mode: "code",
        folders: [],
      }),
    ).toEqual({ create: "Irrigaboi App Montadores" })
  })
})
