import { useEffect } from "react"
import {
  usePromptInputController,
  type MediaAttachmentRef,
  type SourceAttachmentRef,
} from "@/src/components/ai/prompt-input"
import { isFetchableAttachmentUrl } from "@/src/lib/attachment-url"
import { useDraftInput } from "@/src/stores/draft-input"
import { usePanelStore } from "@/src/stores/panel-store"
import type { FilePart } from "@shared/chat"

/**
 * Persisted attachments keep a data URL; the input works with File (converts it to
 * a blob URL in the chip and back to a data URL on submit). This is the way back of that
 * path, used when a revert returns the message to the input.
 *
 * The attachment that is a REFERENCE to the gallery (`mediaId`) does NOT come back as a File: building
 * a File from the URL would make it become a new copy on resend. It comes back through the
 * same path as the drag from the Media tab (addMedia), keeping the reference.
 */
async function restoreAttachments(parts: FilePart[]): Promise<{
  files: File[]
  media: MediaAttachmentRef[]
  sources: SourceAttachmentRef[]
}> {
  const files: File[] = []
  const media: MediaAttachmentRef[] = []
  const sources: SourceAttachmentRef[] = []
  await Promise.all(
    parts.map(async (part) => {
      // Conversation source: it comes back through the drag path of the Sources tab, so the
      // resend keeps being a REFERENCE to the document and not a copy.
      if (part.sourceId) {
        sources.push({ id: part.sourceId, name: part.filename, kind: part.mime })
        return
      }
      if (part.mediaId) {
        media.push({ id: part.mediaId, name: part.filename, mime: part.mime, url: part.url })
        return
      }
      // No bytes to rebuild from: if the attachment became a source of the conversation, it
      // comes back as a REFERENCE to it (the content is stored there); otherwise it is dropped
      // rather than replaced by whatever the empty URL resolves to.
      if (!isFetchableAttachmentUrl(part.url)) {
        if (part.documentId) sources.push({ id: part.documentId, name: part.filename, kind: part.mime })
        return
      }
      try {
        const blob = await (await fetch(part.url)).blob()
        files.push(new File([blob], part.filename ?? "anexo", { type: part.mime }))
      } catch {
        // A corrupted attachment cannot prevent the text from coming back to the input
      }
    }),
  )
  return { files, media, sources }
}

export function DraftInputBridge({ sessionId }: { sessionId?: string }) {
  const controller = usePromptInputController()
  const key = sessionId ?? "draft"
  const draft = useDraftInput((s) => s.drafts[key])
  const pendingInput = usePanelStore((s) => s.pendingInput)

  useEffect(() => {
    if (draft === undefined) return
    const payload = useDraftInput.getState().consume(sessionId)
    if (payload === null) return
    controller.textInput.setInput(payload.text)
    if (payload.files?.length) {
      void restoreAttachments(payload.files).then(({ files, media, sources }) => {
        for (const ref of media) controller.attachments.addMedia(ref)
        for (const ref of sources) controller.attachments.addSource(ref)
        if (files.length > 0) controller.attachments.add(files)
      })
    }
  }, [draft, controller.textInput, controller.attachments, sessionId])

  useEffect(() => {
    if (!pendingInput) return
    if (pendingInput.sessionId !== sessionId) return
    controller.textInput.setInput(pendingInput.text)
    usePanelStore.getState().setPendingInput(null)
  }, [pendingInput, controller.textInput, sessionId])

  return null
}
