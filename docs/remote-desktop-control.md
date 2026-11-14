# Remote desktop control

**Status:** implemented, except the pieces listed under "Not offered" below. Phase 0 (full control), the generic
`peers:request` bridge, the sidebar, the new-chat screen, memories, routines, the pipeline, usage, the media
gallery, questions/permissions and the remote model catalog are in. Still open: the footer indicator, the audit
log and the confirmation gate.

What a remote environment does today (`apps/desktop/src/lib/env-source.ts`, `src/stores/env-sync.ts`):

- `ipc.ts` answers `routinesApi`, `pipelineApi` and `analyticsApi` from the active desktop when one is picked
  (otherwise from this machine); `RoutinesView`, `PipelineBoard` and `UsageView` are the same components.
- Switching environment empties the routines/pipeline stores and the screens load again; events follow the
  same rule (the peer's `routines:event`/`pipeline:event` reach a full-control desktop, this machine's own
  are dropped while another is on screen).
- The sidebar mirrors the local one (folders with nested chats, pinned, recent, archived, sub-chats,
  nav buttons); the new-chat screen follows the mode picked in the sidebar and creates the chat on the
  other machine with the first message. There is no "remote environment" banner.
- Memories, routines and the pipeline are read and edited on the other machine; a routine is created in a
  form that lists THAT machine's models (`providers:snapshot`) and folders (`fs:list-dirs`, through
  `pickFolder()`), and a new code chat starts in one of its folders (a full-control desktop may send
  `directory`; everything else of a send stays that machine's decision).
- The agent's questions and permission requests of a remote chat show as the usual cards and are answered
  there (`ask:reply`).
- Not offered remotely: tools (MCP/skills/hooks), fragments, scripts/secrets of a routine, agents and teams in
  the routine form, task "return with comment", the pipeline report, plan review cards, attachments, and
  choosing the model of a remote chat from the composer.
