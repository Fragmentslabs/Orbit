import type { MessageQueueOp } from "@shared/companion"
import { messageQueueApi } from "@/src/lib/ipc"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"

/**
 * Message queue shared with the companions (mobile), in the design of the
 * other *-sync modules: the renderer is the source of truth — it is what sends the next
 * item when the session becomes free —, pushes the whole queue to main on every
 * change and applies the operations made on the phone. That way there is a single queue per
 * chat: what comes in through the phone shows up here, and vice versa.
 */

function applyRemote(op: MessageQueueOp) {
  const queue = useMessageQueueStore.getState()
  switch (op.op) {
    case "enqueue":
      // The phone redelivers the outbox if the response is lost: the same id does not
      // become a duplicated message.
      if (queue.queues[op.sessionId]?.some((m) => m.id === op.msg.id)) break
      if (op.front) queue.enqueueFront(op.sessionId, op.msg)
      else queue.enqueue(op.sessionId, op.msg)
      // The session may already be free: without this the item would wait for the scheduler.
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
  // Initial state: after a renderer reload the main cache has to
  // be repopulated, otherwise the phone connects and sees an empty queue.
  messageQueueApi.sync(useMessageQueueStore.getState().queues)
  useMessageQueueStore.subscribe((state, prev) => {
    if (state.queues !== prev.queues) messageQueueApi.sync(state.queues)
  })
  messageQueueApi.onOp(applyRemote)
}
