# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Mobile x Desktop: feature gaps (tracked)

## Pending (to do)
1. **Model catalog filters** — the desktop ModelsView filters by provider, capability, price, speed, context
2. **Sources tab** — on the desktop the user declares the conversation's sources (file, pasted text, site) and they become `srcN`/`docN` for the agent. On mobile there is no way to declare or list them: the sources exist and the agent uses them, but they can only be managed on the desktop

## Done
- Document viewer (`components/documents/DocumentViewer.tsx`, opened from the document card and from `#orbit-source/docN/pPLx-y` citations): full-screen WebView over the desktop's own HTML preview (generated documents) or over the source text drawn by the phone (`GET /api/documents/:id/text?sessionId=`, cited lines marked and scrolled to; an uncited .docx uses `GET /api/documents/:id/html`), with outline from headings, find-in-document, zoom (pinch + buttons) and the system share sheet. Not covered: PDF page IMAGES with the text layer (sources open as numbered text), print
- Hours, tokens and cost per project on the usage screen (the summary's `byProject` already came from the companion and was discarded in the app)
- Model rotation on mobile (rotations screen + group in the selector), synced with the desktop through the companion (`GET /api/rotations`, WS `rotation:change` / `rotation:select` / `rotation:set`); the desktop engine is still the one running the sequence
- FilePart in the assistant messages (`case 'file'` in ChatAssistantMessage.tsx)
- DocumentPart announced instead of leaving a hole in the message (`case 'document'`) — the same treatment the artifact already had
- An attached image opens the gallery ORIGINAL on zoom, not the 320px thumbnail of the bubble. It depends on the desktop rewriting `FilePart.mediaUrl` to signed HTTP (companion-media.ts): the app does not know `orbit-media://`
- Full MCP/Skills CRUD on mobile (create, edit, delete, import skills; add, edit, delete, reconnect MCP servers)

