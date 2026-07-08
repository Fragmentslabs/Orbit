import { create } from "zustand"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: Date
}

export interface Chat {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: Date
  updatedAt: Date
}

interface ChatState {
  chats: Chat[]
  activeChatId: string | null
  isProcessing: boolean

  createChat: () => string
  deleteChat: (id: string) => void
  setActiveChat: (id: string | null) => void
  addMessage: (chatId: string, message: ChatMessage) => void
  setProcessing: (processing: boolean) => void
  getActiveChat: () => Chat | undefined
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeChatId: null,
  isProcessing: false,

  createChat: () => {
    const id = crypto.randomUUID()
    const now = new Date()
    const chat: Chat = {
      id,
      title: "Novo Chat",
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      chats: [chat, ...state.chats],
      activeChatId: id,
    }))
    return id
  },

  deleteChat: (id) => {
    set((state) => {
      const chats = state.chats.filter((c) => c.id !== id)
      const activeChatId = state.activeChatId === id
        ? (chats[0]?.id ?? null)
        : state.activeChatId
      return { chats, activeChatId }
    })
  },

  setActiveChat: (id) => set({ activeChatId: id }),

  addMessage: (chatId, message) => {
    set((state) => {
      const chats = state.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: [...c.messages, message],
              updatedAt: new Date(),
              title:
                c.messages.length === 0 && message.role === "user"
                  ? message.content.slice(0, 60)
                  : c.title,
            }
          : c,
      )
      return { chats }
    })
  },

  setProcessing: (processing) => set({ isProcessing: processing }),

  getActiveChat: () => {
    const { chats, activeChatId } = get()
    return chats.find((c) => c.id === activeChatId)
  },
}))
