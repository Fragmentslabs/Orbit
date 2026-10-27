import type { SessionInfo } from "@shared/chat"

/**
 * As pastas de um chat, na ordem que a UI usa: a principal e depois as extras.
 *
 * A sessão em disco é a única fonte que sobrevive ao fechamento do app — o
 * workspace (localStorage) só guarda a última tela. Por isso o que a pessoa
 * associa precisa chegar aqui no mesmo clique, e não no próximo envio.
 */
export function pastasDaSessao(
  session: Pick<SessionInfo, "directory" | "extraDirectories">,
): string[] {
  return [session.directory, ...(session.extraDirectories ?? [])].filter(
    (path): path is string => Boolean(path),
  )
}

/**
 * A lista da tela já é a da sessão?
 *
 * A principal pesa (é o repositório da conversa); as extras são um conjunto,
 * então a ordem entre elas não muda nada e não vale gravar por causa dela.
 */
export function mesmasPastas(daSessao: string[], daTela: string[]): boolean {
  if (daSessao.length !== daTela.length) return false
  if (daSessao[0] !== daTela[0]) return false
  const extras = (lista: string[]) => [...lista.slice(1)].sort().join("\n")
  return extras(daSessao) === extras(daTela)
}
