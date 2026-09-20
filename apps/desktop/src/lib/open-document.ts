import { documentOpensAsFile } from "@shared/media"
import { documentApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Abre um documento do agente no painel — e decide em QUAL aba.
 *
 * São dois objetos com a mesma origem e destinos diferentes: o documento vivo
 * em Markdown abre no canvas, onde se lê e se edita; o que foi PEDIDO como
 * arquivo ("faz um PDF disso") abre no visualizador de documento, com sumário,
 * localizar, zoom e imprimir, que é o que se espera de um arquivo pronto.
 *
 * A decisão mora aqui, e não em cada botão, porque os dois pontos de entrada —
 * o card da conversa e a galeria — têm que concordar: o mesmo documento não
 * pode abrir de um jeito no chat e de outro na galeria.
 *
 * E ela consulta o REGISTRO, em vez de ler a part da mensagem: a part é um
 * retrato do turno em que foi criada, e um documento que virou PDF depois
 * continuaria abrindo como Markdown pelo card antigo.
 */
export async function openDocumentInPanel(
  sessionId: string,
  documentId: string,
  title: string,
): Promise<void> {
  const info = await documentApi.info(documentId)
  const store = usePanelStore.getState()
  // Sem registro o documento sumiu: o visualizador é quem sabe dizer isso ao
  // usuário, nomeando o id que não encontrou.
  if (!info || documentOpensAsFile(info)) {
    store.openSourceTab(sessionId, { docId: documentId, page: 1, title })
    return
  }
  store.openDocumentTab(sessionId, { documentId, title })
}
