import { describe, expect, it } from "vitest"

import type { FolderInfo, SessionInfo } from "@shared/chat"

import { firstSessionOfFolder, sessionWorkspace, workspaceOfFolder } from "@/src/lib/folder-workspace"

/**
 * O caso real: a pasta Nodara estava VAZIA (todos os chats dela apagados) e o
 * "+" abria o chat novo no repositório do último chat aberto — o Orbit. O mapa
 * automático ainda dizia qual projeto era o da pasta; é ele que resolve.
 */

const NODARA_DIR = "/Users/desknik/Projects/Nodara"
const ORBIT_DIR = "/Users/desknik/Projects/Orbit"

const folder = (over: Partial<FolderInfo> = {}): FolderInfo => ({
  id: "f-nodara",
  name: "Nodara",
  mode: "code",
  pinned: false,
  archived: false,
  createdAt: 1,
  ...over,
})

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  title: "chat",
  mode: "code",
  pinned: false,
  archived: false,
  folderId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe("workspaceOfFolder", () => {
  it("pasta vazia: o mapa automático decide (o '+' não herda o repositório do último chat)", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [],
        autoFolderMap: { [NODARA_DIR]: "f-nodara", [ORBIT_DIR]: "f-orbit" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("com chats na pasta, o mais recente decide — inclusive as pastas extras dele", () => {
    const maisNovo = session({
      id: "novo",
      folderId: "f-nodara",
      directory: "/Projects/Nodara-worktree",
      extraDirectories: ["/Projects/api"],
      updatedAt: 20,
    })
    const maisVelho = session({ id: "velho", folderId: "f-nodara", directory: NODARA_DIR, updatedAt: 10 })
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [maisVelho, maisNovo],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual(["/Projects/Nodara-worktree", "/Projects/api"])
  })

  it("o chat mais recente vence o mapa (a pasta segue o uso, não o cadastro)", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-nodara", directory: "/Projects/outro" })],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual(["/Projects/outro"])
  })

  it("chat arquivado também conta: a pasta agrupa os dois estados", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-nodara", directory: NODARA_DIR, archived: true })],
        autoFolderMap: {},
      }),
    ).toEqual([NODARA_DIR])
  })

  it("chat da pasta sem diretório (modo conversa) não decide nada", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-nodara", mode: "chat", directory: undefined })],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("ignora chats de outras pastas", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-orbit", directory: ORBIT_DIR })],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("vários diretórios no mesmo mapa: o nome da pasta desempata", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [],
        autoFolderMap: { "/antigo/xyz": "f-nodara", [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("pasta vazia: a memória dela (workspace do primeiro chat) vence o mapa e traz as extras", () => {
    expect(
      workspaceOfFolder({
        folder: folder({ workspace: [NODARA_DIR, "/Projects/api"] }),
        sessions: [],
        autoFolderMap: {},
      }),
    ).toEqual([NODARA_DIR, "/Projects/api"])
  })

  it("a memória é fallback: com chat na pasta, o mais recente ainda decide", () => {
    expect(
      workspaceOfFolder({
        folder: folder({ workspace: [NODARA_DIR] }),
        sessions: [session({ folderId: "f-nodara", directory: "/Projects/outro" })],
        autoFolderMap: {},
      }),
    ).toEqual(["/Projects/outro"])
  })

  it("pasta sem projeto conhecido devolve undefined (quem chama não mexe no workspace)", () => {
    expect(
      workspaceOfFolder({ folder: folder(), sessions: [], autoFolderMap: { [ORBIT_DIR]: "f-orbit" } }),
    ).toBeUndefined()
  })
})

describe("firstSessionOfFolder", () => {
  it("a MAIS ANTIGA da pasta é a que ensina o workspace — não a mais recente", () => {
    const primeira = session({ id: "a", folderId: "f-nodara", directory: NODARA_DIR, createdAt: 1 })
    const recente = session({ id: "b", folderId: "f-nodara", directory: ORBIT_DIR, createdAt: 9 })
    expect(firstSessionOfFolder("f-nodara", [recente, primeira])?.id).toBe("a")
  })

  it("ignora chats de outras pastas, do modo conversa e sem diretório", () => {
    const barulho = [
      session({ id: "outro", folderId: "f-orbit", directory: ORBIT_DIR, createdAt: 0 }),
      session({ id: "conversa", folderId: "f-nodara", mode: "chat", createdAt: 0 }),
      session({ id: "sem-dir", folderId: "f-nodara", directory: undefined, createdAt: 0 }),
    ]
    expect(firstSessionOfFolder("f-nodara", barulho)).toBeUndefined()
    expect(
      firstSessionOfFolder("f-nodara", [
        ...barulho,
        session({ id: "valido", folderId: "f-nodara", directory: NODARA_DIR, createdAt: 5 }),
      ])?.id,
    ).toBe("valido")
  })
})

describe("sessionWorkspace", () => {
  it("principal + extras, na ordem; undefined sem diretório", () => {
    expect(sessionWorkspace(session({ directory: "/a", extraDirectories: ["/b"] }))).toEqual(["/a", "/b"])
    expect(sessionWorkspace(session())).toBeUndefined()
  })
})
