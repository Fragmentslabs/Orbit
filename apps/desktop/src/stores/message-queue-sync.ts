import type { MessageQueueOp } from "@shared/companion"
import { messageQueueApi } from "@/src/lib/ipc"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"

/**
 * Fila de mensagens compartilhada com os companions (mobile), no desenho dos
 * outros *-sync: o renderer é a fonte da verdade — é ele quem envia o próximo
 * item quando a sessão fica livre —, empurra a fila inteira para o main a cada
 * mudança e aplica as operações feitas no celular. Assim existe uma fila só por
 * chat: o que entra pelo celular aparece aqui, e vice-versa.
 */

function applyRemote(op: MessageQueueOp) {
  const queue = useMessageQueueStore.getState()
  switch (op.op) {
    case "enqueue":
      // O celular reentrega o outbox se a resposta se perder: o mesmo id não
      // vira mensagem duplicada.
      if (queue.queues[op.sessionId]?.some((m) => m.id === op.msg.id)) break
      if (op.front) queue.enqueueFront(op.sessionId, op.msg)
      else queue.enqueue(op.sessionId, op.msg)
      // A sessão pode já estar livre: sem isto o item esperaria o agendador.
      queue.processQueue(op.sessionId)
      break
    case "remove":
      queue.remove(op.sessionId, op.msgId)
      break
    case "move-to-front":
      queue.moveToFront(op.sessionId, op.msgId)
      break
    case "update":
      queue.update(op.sessionId, op.msgId, op.text)
      break
    case "send-now":
      queue.sendNow(op.sessionId, op.msgId)
      break
  }
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Estado inicial: depois de um reload do renderer o cache do main precisa
  // ser repopulado, senão o celular conecta e vê a fila vazia.
  messageQueueApi.sync(useMessageQueueStore.getState().queues)
  useMessageQueueStore.subscribe((state, prev) => {
    if (state.queues !== prev.queues) messageQueueApi.sync(state.queues)
  })
  messageQueueApi.onOp(applyRemote)
}
