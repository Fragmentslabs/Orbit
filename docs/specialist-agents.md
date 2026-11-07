# Specialist agents

Status: built for fragments, Motion and Design through one generic layer (see "How it is
built" in section 3): profiles, the agent selector, the sidebar icon, the suggestion card,
and the conversation card with the chat list on all three screens. Not built yet: user-made
agents. The first profile was the
lean fragment chat (see [fragments.md](fragments.md), "Creating and editing live").

## 1. The idea

A general chat carries a large system prompt, memories, skills and many tools. For a
narrow craft (a fragment, a design board, a motion timeline) most of that is noise and
the domain knowledge that matters is missing or diluted. A **profile** replaces the
general setup for the whole conversation with one built for the craft:

- a focused system prompt with the domain knowledge (formats, rules, examples, common
  mistakes);
- only the tools of the craft;
- the state of the artifact injected at every turn (timeline, selection, files);
- none of the blocks that make no sense there (memories, skills, unrelated modes).

A profile is a definition: system prompt, allowed tools, which blocks are on, default
model and thinking. Built-in profiles and user-made profiles are the same mechanism;
only the source of the definition differs.

Quality is not guaranteed by removing context. The expected gain comes from three things
together: domain knowledge in the prompt, the artifact state each turn, and visual or
error feedback after each action (a rendered frame, a console error). Motion in
particular depends on the third. Measure before investing: the same set of requests
(about ten) in the current chat and in the new profile, judging the result.

## 2. Built-in profiles

| Profile | State | Notes |
|---|---|---|
| Fragment | Done (lean chat) | `fragmentProfileOf`, `fragmentSystemPrompt`, per-turn `<fragment-context>` |
| Motion | Done, not yet measured | Craft prompt plus the motion guide; motion, font and sound tools only; compositions listed each turn |
| Design | Done, not yet measured | Craft prompt plus the design guide; design and font tools only; canvases listed each turn |

Frame feedback for Motion (`motion_frame`) already exists in the tool set. Still to do:
measure the new profile against the general chat on a fixed set of requests, and add
selection and timeline state to the per-turn block.

The engine asks `profileOf(sessionId)` (`electron/lib/profiles/index.ts`), reading the
session on disk, never the UI. A profile gives the system prompt, the toolset and the
per-turn block, and `leanOptions` switches off memories, research, browser, computer,
subagents, orchestration and plan. `SessionInfo.profile` holds `motion` or `design`; the
fragment chat keeps its own `fragment` field, and `specialistProfileOf` reads both.

A fragment records every chat that worked on it (`sessionIds` in the manifest). The card
lists them, starts a new one, and opens the current one in the side panel. Chats of a
fragment show in the sidebar with the fragment icon, and clicking one opens the fragment.

A new chat picks its agent in the header (`AgentSelector`); the choice is applied when
the first message creates the session and is fixed from then on, shown as a badge.

## 3. Where these chats live

Rule: **a specialist chat belongs to its artifact, not to the sidebar.**

- **Created from the artifact's own page** (Fragments page): the chat is embedded in the
  artifact. It never shows in the sidebar, which is split into Chat and Code and would
  hide it from one of them. It is reached from the artifact: the conversation card lists
  the chats associated with that artifact (`sessionIds` in the manifest), starts a new
  one, and opens the current one in the side panel.
- **Created from a normal chat:** the agent's first `fragment_create`, `motion_write` or
  `design_write` offers a specialist subchat. If accepted, it is a subchat nested under
  that chat in the sidebar, with the icon of its craft, and the artifact opens in the side
  panel while it works. If declined, the work stays in the chat as before.
- **Sidebar rule:** a fragment chat only shows in the sidebar when it has a parent chat.
  Motion and Design chats are specialist subchats of their origin chat.
- **Browser** is not a specialist: it stays tied to the chat it was opened from, in
  fullscreen, with the same conversation card but no history or selector.
- The left card shows a fixed line with the active agent (for example "Motion agent ·
  lean"). Associating a regular chat means the full agent is used; the card says so.
- Motion and Design pieces still live in the folder of the chat that made them, but their
  chats are listed like any other: a chat made inside the artifact is told the piece id and
  reaches it through the tools' `id` argument.
- The list shows the artifact's chats in two groups: the ones made inside it, and the
  subchats of a chat in the sidebar. "New chat" always makes one inside it.

### How it is built: one layer for every kind

Everything about "which chats belong to an artifact" is generic. A kind plugs in through
one table, and nothing else in the app branches on the kind.

| Piece | Where | Role |
|---|---|---|
| `ArtifactRef`, `ArtifactChats`, `isEmbeddedArtifactChat` | `packages/shared/src/artifacts.ts` | Types, IPC channel names and the sidebar rule |
| Kind descriptors | `electron/lib/artifacts/kinds.ts` | Per kind: the tools that create or change it, and how to get its id from a call |
| Chat registry | `electron/lib/artifacts/chat-registry.ts` | One record per artifact: the chats in order and the current one. Serialized writes |
| Tracking | `electron/lib/artifacts/tracking.ts` | Wraps the descriptor tools: a chat that ran one joins the artifact's list |
| IPC | `electron/lib/artifacts/artifact-ipc.ts` | list, associate, set current, and a change event |
| Profile | `electron/lib/profiles/index.ts` | Prompt, tools and per-turn block of the lean chat |
| Renderer store and hook | `stores/artifact-chats-store.ts`, `hooks/use-artifact-chat.ts` | The shown chat, the list, select, create embedded, ensure |
| Embedded chat fields | `lib/artifact-session.ts` | The one place that knows how each kind marks its chat |
| Card | `components/artifact/` | `ArtifactChatTools` (select, new, open in panel) and `ArtifactChatFeed` |

The chat list is shown the same way on all three screens: the floating feed on Fragments and
Motion, and a tab of the left sidebar on Design (`ConversationBody` is the shared body).

**Adding a new kind:** add its name to `SpecialistProfile`, one entry in `kinds.ts`, one
case in `profiles/index.ts` (prompt, tools, turn block) and, if its chats are marked in a
special way, one line in `artifact-session.ts`. The registry, tracking, IPC, hook, card and
sidebar rule need no change.

The fragment manifest no longer keeps a chat list: only the chat it was born in (`sessionId`),
which creation and the turn block use. The list lives in the registry for every kind.

### Where the artifact opens, and who may write to it

- A subchat makes its artifact under its own session id, but the person is usually looking at the
  parent. `resolvePanelSession` (`src/lib/panel-session.ts`) re-targets the artifact's panel
  event along the parent chain: the chat on screen wins when it is the subchat or an ancestor,
  otherwise the topmost ancestor does.
- Writes to the same artifact from a parent chat and its subchat go through `withAssetLock`
  (`electron/lib/asset-lock.ts`), the one lock motion, design and fragments share. A fragment edit
  reads inside the lock (`editFragmentFile`), so a stale edit fails on its `oldText` instead of
  overwriting the other chat's work.
- The offer carries the fragment kind the agent asked for into the new subchat (`fragmentKind`).

### A specialist subchat is a normal subchat

It nests under its parent and runs the same machinery: the parent sees its latest result in
the subchats block, reads it with `read_subchat`, sends it instructions with `send_to_subchat`
and is woken when it finishes. Only the agent inside differs.

What is added is that the parent can reach **what the subchat made**. The registry also keeps
the way back (`artifactsOfChat/<chat>`, written in the same call as the artifact's chat list),
each kind says how to name its artifacts and which argument carries the id (`kinds.ts`:
`nameOf`, `idArgument`), and `describeChatArtifacts` turns it into one line per artifact. Those
lines go into the wake-up message and into a "Made:" line of the subchats block, so the parent
can read or change the piece itself with the tools of its craft instead of sending it back.
It works for every kind with no per-kind code beyond its descriptor.

## 4. Suggesting a specialist from a normal chat

Implemented for Fragment, Motion and Design (`withSpecialistOffer` in `tools/subchats.ts`): the
first `fragment_create`, `motion_write` or `design_write` of a general chat shows the card instead of
running; "create" opens a specialist subchat with the user's request as its brief,
"continue here" runs the tool and the offer is not repeated in that conversation. It
reuses the existing subchat ask, so it survives a restart as a plain subchat card.
A fragment created from the Fragments page does not go through the offer: it gets its own embedded chat.

Treated as a subchat with the mode icon, linked to the chat it came from.

- Offered only at the moment the general agent would **create** a design, motion or
  fragment, not whenever a message sounds related. Detected by that gesture, not by a
  new tool in the general prompt (which would add weight to the prompt this work
  tries to slim).
- Once per conversation. "Continue here" holds until the chat ends.
- The card is short with two clear buttons. It states the benefit ("a chat optimized
  for this") and what is passed: a summary of the context, not the whole
  conversation. The summary loses nuance and the card says so.
- When the specialist finishes it returns one line to the parent ("animation ready:
  file X"), as subchats already do.

## 5. User-made agents (later)

Users create agents with a custom prompt. The header shows a badge or a selector with
the active agent.

- **Fixed per conversation.** Switching mid-chat breaks the prompt cache and mixes
  instructions, so the selector applies when the chat starts; switching later means a
  new chat or a subchat.
- **A profile only restricts or toggles; it never grants.** It cannot give itself more
  permission than the user has, so a custom prompt is not a way around approvals.
- **Different from skills and modes.** A skill is knowledge loaded on demand, a mode is
  a behavior switched on, an agent is the base identity of the conversation. The UI
  must keep the three apart.
- **Transparency.** The badge leads to a view of exactly what the profile injects
  (prompt, tools, blocks).
- **Optional connections.** By default a fragment agent is empty: no prompt injection,
  no memories. Vision, subagents, orchestra, loop and memories are switches the user
  turns on per fragment or per agent.

### Sharing and security

A prompt from outside speaks to the model with system authority, so an imported agent
is a prompt-injection surface. The same rules as fragments apply
(see [fragments.md](fragments.md), "Provenance"):

- it arrives as **third party**, with the provenance recorded by Orbit;
- the consent card shows the **full prompt** and the tools it enables;
- nothing is activated before the user accepts.

A fragment from a third party that ships a profile is covered by the same card.

## 6. Order

1. Generalize the profile lookup in the engine.
2. Motion profile, measured against the current chat.
3. Design profile.
4. Artifact id on the session, sidebar mode icon, left-card selector and history.
5. Suggestion card in normal chats.
6. Only then the editor for user-made agents and the header selector, once two or
   three built-in profiles have proven the abstraction and shown what the editor must
   expose.

## 7. Open questions

- How much of the summary passed to a specialist is written by the model and how much
  is the artifact's own state.
- Whether Design and Motion get their own tool sets or share a base with fragments.
- Whether the "continue here" choice is per chat or remembered per artifact kind.
