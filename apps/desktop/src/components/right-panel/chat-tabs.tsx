import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { MessagesSquare } from "lucide-react"
import type { SendMessageOptions, FilePart } from "@shared/chat"
import { sessionIcon } from "@/src/components/agent-meta"
import { ChatInput } from "@/src/components/chat-input"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector } from "@/src/components/folder-selector"
import { CompactWorkspaceSelector } from "@/src/components/workspace-selector-compact"
import { Truncate } from "@/components/ui/truncated-text"
import { useWorkspace } from "@/lib/workspace-context"
import { useSessionStore } from "@/src/stores/session-store"
import { useEnvSessions } from "@/src/hooks/use-env-sessions"

// Conversation tabs of the right panel (moved out of right-panel.tsx).

/** The icon of a conversation tab: the craft's icon for a specialist chat, nested bubbles otherwise. */
export function ChatTabIcon({ sessionId }: { sessionId: string }) {
  // The chats of the machine on screen: a remote conversation tab finds its craft there too.
  const sessions = useEnvSessions()
  const Icon = sessionIcon(sessions.find((x) => x.id === sessionId) ?? {}) ?? MessagesSquare
  return <Icon className="size-3.5 shrink-0" />
}

export function NewChatTab({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const { t } = useTranslation()
  // The folders of the tab are born like the screen's (the new chat would start the same as the
  // main panel's), but they change only here: the draft of a tab is not a
  // folder association of the chat that is open in the window.
  const { folders: screenFolders } = useWorkspace()
  const [folders, setFolders] = useState<string[]>(screenFolders)
  const handleSubmit = async (text: string, options: SendMessageOptions, files?: FilePart[]) => {
    if (folders.length > 0) {
      // Mirrors the main panel: a new chat with a folder becomes a code session
      const [directory, ...extraDirectories] = folders
      const newSession = await useSessionStore.getState().createSession("code", { setActive: false, directory, extraDirectories })
      onCreated(newSession.id)
      await useSessionStore.getState().sendMessage("code", text, { options, sessionId: newSession.id, directory, extraDirectories, files })
    } else {
      const newSession = await useSessionStore.getState().createSession("chat", { setActive: false })
      onCreated(newSession.id)
      await useSessionStore.getState().sendMessage("chat", text, { options, sessionId: newSession.id, files })
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-4" style={{ '--panel-bg': 'var(--sidebar)' } as React.CSSProperties}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <FolderSelector folders={folders} onFoldersChange={setFolders} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex flex-col items-center gap-2">
          <p className="text-lg font-medium text-foreground">{t("panel.newChat.title")}</p>
          <p className="text-sm text-muted-foreground">{t("panel.newChat.subtitle")}</p>
        </div>
      </div>
      <ChatInput onSubmit={handleSubmit} draftKey="panel" />
    </div>
  )
}

/** Header of a chat opened in a tab: name + folder + branch, like the main panel header */
export function ChatTabHeader({ sessionId }: { sessionId?: string }) {
  const session = useSessionStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const setSessionDirectories = useSessionStore((s) => s.setSessionDirectories)
  const folders = useMemo(() => {
    if (!session?.directory) return []
    return [session.directory, ...(session.extraDirectories ?? [])]
  }, [session])

  const handleAgentAction = useCallback((instruction: string) => {
    if (!sessionId) return
    const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
    void useSessionStore.getState().sendMessage("code", instruction, {
      options: { simple: true },
      sessionId,
      directory: s?.directory,
      extraDirectories: s?.extraDirectories,
    })
  }, [sessionId])

  if (!session) return null

  const isCode = session.mode === "code" && !!session.directory

  // The association belongs to the tab session — the workspace is the main window's and
  // cannot start pointing at the folders from here.
  const handleFoldersChange = (next: string[]) => {
    setSessionDirectories(session.id, next[0], next.slice(1))
  }

  return (
    // z-20: `@container` creates a stacking context (layout containment), so
    // without it the folders dropdown stays trapped below the gradient at the top of the chat.
    // `bg-sidebar` + `shrink-0`: the conversation here has no veil, and without its own
    // background what passed under the header (message scrolling, card)
    // appeared behind the title and the folder chip.
    <div className="@container relative z-20 flex min-w-0 shrink-0 items-center gap-2 bg-sidebar px-1 pb-2">
      <Truncate text={session.title}>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{session.title}</span>
      </Truncate>
      <div className="hidden min-w-0 items-center gap-2 @xl:flex">
        {isCode && session.directory && <BranchSelector repoPath={session.directory} onRequestAgentAction={handleAgentAction} />}
        {folders.length > 0 && <FolderSelector folders={folders} onFoldersChange={handleFoldersChange} compact />}
      </div>
      <div className="flex min-w-0 items-center @xl:hidden">
        <CompactWorkspaceSelector
          repoPath={isCode ? session.directory : undefined}
          folders={folders}
          onFoldersChange={handleFoldersChange}
          onRequestAgentAction={handleAgentAction}
        />
      </div>
    </div>
  )
}

