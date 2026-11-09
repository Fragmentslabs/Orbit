# Specialist agents

Status: built for fragments, Motion and Design through one generic layer (see "How it is
built" in section 3): profiles, the agent selector, the sidebar icon, the suggestion card,
and the conversation card with the chat list on all three screens. User-made agents are built
(section 5): the Specialists tab of the Tools page, the store, the header selector. Not built:
importing and sharing agents, and a tool picker in the editor. The first profile was the
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

Frame feedback for Motion (`motion_frame`) already exists in the tool set. The per-turn block
also carries what the person has on screen (section 3, "What the person is looking at"). Still
to do: measure the new profile against the general chat on a fixed set of requests.

The engine asks `profileOf(sessionId)` (`electron/lib/profiles/index.ts`), reading the
session on disk, never the UI. A profile is a `ProfileDefinition` (`profiles/types.ts`): the
system prompt, optional craft tools, an optional tool allowlist, the `blocks` that are on, the
per-turn block, and a default model and thinking. `restrictInput` applies it by clearing what
its blocks switch off (memories, skills, subagents, orchestra, loop, vision, web, computer,
plan). `SessionInfo.profile` holds a `ProfileId`: `motion`, `design`, `fragment` or
`agent:<id>`; the embedded fragment chat keeps its own `fragment` field, and
`specialistProfileOf` reads both.

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
| Profile | `electron/lib/profiles/` | `types.ts` (definition), `builtin.ts` (the three crafts), `user.ts` (an agent as a definition), `index.ts` (resolve, `restrictInput`), `tool-blocks.ts` (what each block removes), `turn-blocks.ts`, `describe.ts` |
| View state | `electron/lib/artifacts/view-state.ts`, `src/hooks/use-artifact-view.ts` | What the person has selected or open in a tab, told to the chat at the next turn |
| Renderer store and hook | `stores/artifact-chats-store.ts`, `hooks/use-artifact-chat.ts` | The shown chat, the list, select, create embedded, ensure |
| Embedded chat fields | `lib/artifact-session.ts` | The one place that knows how each kind marks its chat |
| Card | `components/artifact/` | `ArtifactChatTools` (select, new, open in panel) and `ArtifactChatFeed` |

The chat list is shown the same way on all three screens: the floating feed on Fragments and
Motion, and a tab of the left sidebar on Design (`ConversationBody` is the shared body).

**Adding a new kind:** add its name to `SpecialistProfile`, one entry in `kinds.ts`, one
definition in `profiles/builtin.ts` (prompt, tools, turn block) and, if its chats are marked in
a special way, one line in `artifact-session.ts`. The registry, tracking, IPC, hook, card and
sidebar rule need no change.

The fragment manifest no longer keeps a chat list: only the chat it was born in (`sessionId`),
which creation and the turn block use. The list lives in the registry for every kind.

### What the person is looking at (Motion and Design)

The selection, the playhead and the active board only exist in the tab, so the tab reports them
(`useArtifactView`, one call in `motion-tab.tsx` and one in `design-tab.tsx`, the text is built in
`motion-view-state.ts` and `design/design-view-state.ts`). Main keeps the latest report per kind
in memory (`view-state.ts`) and `turn-blocks.ts` adds it to `<motion-context>` and
`<design-context>`.

- Motion: the piece, the selected layer or sound, the frame of the playhead with its time, and the
  timeline (the frames where each layer is in the scene).
- Design: the canvas, its artboards with sizes, the active artboard, the selected element (tag and
  child-index path, which is how the design tools address it, and its text) and the group size.
- It is screen state, so it lives in memory only and a closing tab clears its own report. It is the
  person's view, not an instruction: every value is cut to one short line, keys are validated, and
  the block says so. It goes in the user message, never in the system prompt, to keep the cache.
- Not done: it reports the tab that was touched last, not a tab per piece, so two Motion tabs open
  at once are not told apart.

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
reuses the existing subchat ask, so it survives a restart as a plain subchat card. The answer
(any answer) is saved per conversation and craft (`specialist-offers.ts`, key
`specialist-offers/<session>`, removed with the conversation), so it also holds after a restart.
The chat-mode toolset used to skip this wrapper and the artifact tracking; it now has both.
A fragment created from the Fragments page does not go through the offer: it gets its own embedded chat.

Treated as a subchat with the mode icon, linked to the chat it came from.

- Offered only at the moment the general agent would **create** a design, motion or
  fragment, not whenever a message sounds related. Detected by that gesture, not by a
  new tool in the general prompt (which would add weight to the prompt this work
  tries to slim).
- Once per conversation. "Continue here" holds for the life of the chat, restarts included.
- The card is short with two clear buttons. It states the benefit ("a chat optimized
  for this") and what is passed: a summary of the context, not the whole
  conversation. The summary loses nuance and the card says so.
- When the specialist finishes it returns one line to the parent ("animation ready:
  file X"), as subchats already do.

## 5. User-made agents

Built. The person writes agents in the **Specialists** tab of the Tools page (reachable from both
chat and code mode; the Tools button is no longer code-only) and picks one in the header when a
chat starts.

- **A new agent starts empty.** No prompt means the model gets no system prompt at all, and
  nothing else is injected. Five switches turn Orbit features on, all off by default: vision,
  subagents, orchestra, loop and memories. "On" only means the agent does not block the feature;
  it never forces it on, and the person's settings, the conversation toggles and the model's
  abilities still decide.
- **What an agent removes.** Its system prompt is exactly its prompt (the general prompt, skills
  index, project context and memories are not there). Its toolset is the conversation's usual
  one without Orbit's own machinery: skills, scheduling, pipeline, other chats and usage, hooks,
  connection setup, and the subagent and subchat tools unless the subagents switch is on. Web,
  computer and plan stay under the person's own composer toggles.
- **Fixed per conversation.** The agent is stored on the session when the chat is created
  (`SessionInfo.profile = agent:<id>`) and read from disk each turn. Switching mid-chat would break
  the prompt cache and mix instructions, so the selector is only a selector for a new chat and
  becomes a badge afterwards. Editing an agent changes its chats from their next turn (one cache
  miss); deleting it makes its chats fall back to the general setup.
- **A profile only restricts or toggles; it never grants.** `restrictInput` only clears options,
  `restrictTools` only deletes tools (in place, so `run_tools` cannot reach what was removed), and
  no field of a definition adds a permission, a tool, an approval bypass or a model. Loop and
  orchestra are routed before the engine, so the dispatcher applies the profile too.
- **Different from skills and modes.** A skill is knowledge loaded on demand, a mode is
  a behavior switched on, an agent is the base identity of the conversation. The UI keeps
  the three apart: agents live in their own tab and in the header, not in the composer.
- **Transparency.** The badge of a chat, and every card in the tab, opens a read-only view of
  exactly what the profile injects: the system prompt, the tools, which blocks are on, and what is
  added each turn. For the built-ins it is built from the same definition the engine runs
  (`profiles/describe.ts`).
- **Storage.** One file, `agents` under the app storage, written atomically and serialized.
  Limits are in `AGENT_LIMITS` (50 agents, 60-character names, 20,000-character prompts, 200
  tool names). `agents/validate.ts` is the single validator: the editor's payload and the file
  both go through it, unknown fields are dropped, only a literal `true` turns a feature on, and
  an invalid record in the file is skipped instead of reaching the engine.

### The definition format (ready for sharing)

`AgentInput` in `packages/shared/src/agents.ts` is the portable part: `name`, `icon`, `prompt`,
`features`, and the optional `allowedTools`, `defaultModel` and `thinking`. It carries no id and
nothing tied to this installation. A saved `AgentDefinition` adds `version` (the format version,
`AGENT_FORMAT_VERSION`), `id`, `origin` (`user` or `imported`, reserved for the sharing flow) and
timestamps. Export is just `AgentInput` as JSON; import would run the same `sanitizeAgentInput`.

Not built, on purpose:

- **Importing and sharing agents.** It needs the consent flow below. Nothing imports yet, and
  `origin: 'imported'` is never written.
- **A tool picker.** `allowedTools` is validated and enforced by the engine, but the editor does not
  expose it. The names to offer would come from building the conversation's toolset.
- **Applying `defaultModel` and `thinking`.** They are in the format and validated, but choosing an
  agent does not change the model selector yet.
- Nothing here has been checked in the real window: types, lint and tests only.

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
6. The editor for user-made agents and the header selector (done), once two or
   three built-in profiles proved the abstraction.
7. Importing and sharing agents with the consent card (not done).
8. Agents as one definition used in chats, suggestions and orchestra (section 8, design only).

## 7. Open questions

- How much of the summary passed to a specialist is written by the model and how much
  is the artifact's own state.
- Whether Design and Motion get their own tool sets or share a base with fragments.
- Whether the "continue here" choice is per chat (what is built) or remembered per artifact kind.

## 8. Direction: one agent, used in three places

Status: **design, not built.** Sections 1–7 describe what exists. This one records where it goes next.

Terms, so they are not mixed up:

- **Subagent**: the existing subagent mode. Unchanged by everything below.
- **Subchat**: a child chat the *current chat suggests* (an ask card). Specialist subchats are the
  ones started with an agent.
- **Worker**: a child chat the *orchestrator creates* in orchestra mode.

A worker and a subchat are the same thing: **a child chat running an agent**. They differ only in
who decides to create it.

| Where | Who decides | Asks the person? | Agent |
|---|---|---|---|
| Normal chat | The chat suggests | Yes, a suggestion card | Any agent in the catalog |
| Orchestra mode | The orchestrator | No, it just runs | Any agent, or the default one |
| Routine with orchestra | The orchestrator | Nobody to ask | Same |

The generic worker stops being a concept of its own: it becomes "a child chat with the default
agent". Subchats with specialists (section 4) are already this mechanism, so it needs no new one.

### 8.1 The agent is one definition

- **Built-ins are ordinary, editable definitions.** Fragment, Motion and Design are shipped as
  pre-made agents edited exactly like the person's own, with "restore default". The person can
  have several agents of one craft (for example one Motion agent per kind of video).
- **A default arsenal** ships as well: code review, security, infrastructure, validation and
  research. They serve as orchestra workers and as phases of a pipeline.
- **Minimal base prompt, then one block per active capability.** The base is identity, language
  and how to answer. Every capability (skills, browser, routines, memories, ...) is a module that
  adds its tools *and* its usage instructions only while it is on. The general chat becomes the
  agent with everything on; today's two paths (general and lean) become one.
- **Allow-lists.** Tools, skills and MCP servers are each "all" or a chosen list. As in section 5,
  a definition only restricts; it never grants more than the person already has.
- **Pinned skills.** A skill can be fixed on an agent: its full text goes into the system prompt.
  The others stay an index read on demand. Pinning costs tokens every turn, so the agent screen
  shows the weight of the prompt, the pinned skills and the tools.
- **A "when to use" line.** It drives routing, both for suggestions and for the orchestrator. It
  is drafted when the agent is created and the person can edit it.
- **Created from a prompt, like routines.** The person describes the agent; Orbit proposes name,
  description, prompt, modules, lists and the "when to use" line, and the person approves a card
  before anything is saved. The card is required: the generated prompt speaks with system
  authority.
- **Fixed per chat, as today.** The agent is stored on the session at creation, so the cache holds.

### 8.2 The normal chat suggests, and does not become an orchestrator

The risk is a chat that keeps trying to delegate. The rules are explicit, not left to judgment:

- The chat sees a **compact catalog**: name plus the "when to use" line. Never whole prompts.
- It suggests only when the task **clearly matches** an agent *and* produces something worth its
  own chat (an artifact, a long review, a large research). A simple question or a small edit never
  triggers a suggestion.
- **One suggestion at a time**, never again for the same task. "Don't suggest again" is stored,
  like the existing offer decisions (`specialist-offers`).
- Each agent has a "can be suggested" switch.
- Any agent can be suggested, not only the built-ins. Today's gesture-based offer
  (`withSpecialistOffer`) stays for the craft tools and the catalog extends it.

### 8.3 Orchestra mode

- **It runs without asking.** Turning orchestra on is the authorization. Permission modes (ask,
  autonomy) still apply inside each worker, and a critical question reaches the parent chat.
- **Workers are child chats with an agent**, picked from the catalog by the "when to use" line, or
  the default agent when none fits.
- **Ephemeral agents.** The orchestrator may build an agent for one run, with its own prompt and
  tools, never with more permission than the orchestrator itself has. It is not saved; the run
  ends with a "save as agent" button. This keeps the flexibility without piling up permanent
  definitions nobody approved.
- **The interface is in the conversation, not a fixed panel.** Each worker is a card in the
  message flow that runs live: thinking, the answer streaming, expandable to the full chat,
  like Claude's subchats. Messages between workers appear in the flow too; they talk through a
  message tool that is always visible, not through hidden shared memory.
- **Results return as a summary plus references** to what the worker made ("Made:" lines, as in
  section 3), not the worker's whole transcript.

### 8.4 Routines and pipelines

A routine can turn on orchestra and run many agents at once (for example a video: script, voice,
image research and design in parallel). Because nobody is watching, it needs:

- **A plan with dependencies.** Independent steps run together; a step waits for what it depends on
  (the voice waits for the script).
- **A concurrency limit and a token or cost budget per run.** Without one, ten agents can spend a
  lot before anyone notices.
- **Permissions fixed when the routine is created.** There is nobody to answer a card at 3 a.m.
- **A failure policy per routine:** retry, continue without that step, or abort.
- **Pipeline phases can name an agent**, so a phase runs as, say, the security agent.

### 8.5 Order

1. The agent as a single definition: editable built-ins, pinned skills, tool and skill lists, the
   "when to use" line, the weight display.
2. The prompt in modules, with the general chat as "everything on". Done gradually, starting with
   the modules already well separated (browser, skills, routines, memories), and measured before
   and after: the general prompt is large and tuned, so this is the riskiest step.
3. The catalog and the suggestion rules in the normal chat.
4. Orchestra workers as agent chats, and the inline interface.
5. Routines and pipelines with agents: dependency plan, limits, budget.
6. Ephemeral agents with "save as agent".

Step 1 is **built except creation from a prompt**:

- `whenToUse` and `pinnedSkills` on every agent (`agents/validate.ts`; pinned bodies read by
  `agents/pinned-skills.ts` when the turn's profile is resolved). Pinned skills are an agent's
  skill allow-list: an agent has no skills index, so it knows only what is pinned.
- Built-ins editable through a small override layered on the shipped definition
  (`agents/overrides.ts`, `withOverride` in `profiles/builtin.ts`); "restore default" deletes it.
- **Craft agents:** `AgentInput.craft` (motion, design, fragment) gives a user agent that craft's
  tools, blocks and artifact while the prompt, "when to use" and pinned skills are its own, so a
  person can have several Motion agents. Not yet done: the suggestion card and the artifact
  offer still name the built-in craft, not these agents (step 3).
- **Tool limit** in the editor: off = every tool of the chat, on = a chosen list. The picker
  offers the always-on tools plus any name typed in, because family tools depend on the turn.
- **Starting agents** (`agent-templates.ts`): code review, security, infrastructure, validation
  and research, added from the Specialists tab as ordinary agents the person then owns.
- The weight is shown in the profile view and in the editors; descriptions of the person's agents
  are now built in the main process (`describeAgents`) from the definition the engine runs.

- **Creating an agent from a prompt**, two ways, both only *proposing*:
  - **Tools → Specialists → New agent → Ask Orbit** opens the same modal as skills and hooks
    (`AskOrbitDialog`, `kind="agents"`). `agents/generator.ts` makes one headless model call
    and the draft goes through `sanitizeAgentInput` (unknown craft, non-literal switches and
    pinned skills that do not exist are dropped); the editor opens filled in and the person
    reviews and saves.
  - **The `create_agent` chat tool** (`tools/create-agent.ts`, in chat and code mode, not for
    workers or for agents other than the general chat) proposes an agent. Nothing is saved when
    it runs; an "Add agent" card shows the whole prompt and the agent exists only after the
    person clicks. The card derives "added" from the agents list, so it survives a restart.

Step 1 is complete. Nothing was checked in the real window.

Step 2, first half, is done: `buildSystemPrompt` now assembles `buildPromptSections()`, a list of
`{ id, text }` pieces (`mode`, `permissions`, `visuals`, `documents`, `tools-map`, `subchats`,
`memory`, `closing`, …) whose joined text is byte-identical to the old prompt (checked over 13
turns — chat, code, plan, worker, web, brain, simple, `/create-skill` — before the baseline test
was removed). Measured with the tool catalog on, in tokens (chars / 4): chat ≈ 3.0k, code ≈ 5.5k.
The heaviest chat parts are `visuals` (1.2k, the orbit-ui syntax and image rules), `documents`
(0.8k) and `mode` (0.3k); in code mode the code prompt itself is 2.2k. `prompts-weight.test.ts`
holds ceilings (chat 3.5k, code 6.2k) so growth is a decision.

Step 3 is done for the user's own agents. The general chat's prompt gets an `agents` section
(`agents/suggestions.ts`) when at least one agent has a "when to use" line and a prompt: one line
per agent (`agent:<id> — name: when`, at most 20, never the prompt) plus rules that keep it quiet
— only on a clear match with real work, one at a time, silence by default. `suggest_subchat` takes
an optional `agent`; the card shows the agent's name and icon, and accepting opens a chat that
runs that agent. The answer, whatever it is, is recorded per conversation (the same record the
craft offers use), so an agent is never suggested twice in one chat. An empty "when to use" is the
"can be suggested" switch — there is no second one. Built-in crafts are still offered at the
gesture that creates their piece, not through the catalog. The catalog costs nothing without
agents and about 40 tokens per agent. Worker, plan and specialist chats never see it.
Not done: a global "don't suggest this again" beyond the conversation, and the real window check.

Step 4 is done in two of its four parts. (a) **Workers as agent chats.** `create_task` takes an
optional `agent` (an id from the catalog the orchestrator is given when it plans, built by
`workerAgentsBlock`); the task records it (`OrchestrationTask.agent`), the worker's session is
created with that `profile`, and every turn of the worker runs the agent's own setup. An agent
worker keeps its own prompt and gets only `WORKER_AGENT_CONTRACT` (one task, no clarifying
questions, narrow checks, end with a summary) instead of the general worker prompt. An unknown
agent id refuses the task rather than silently using the general worker. (b) **No ask to run.**
`OrchestrationSettings.autoApprove`, a switch in the orchestra settings: every plan starts as soon
as it is planned (the card still appears as the record). It is OFF by default, so nothing changes
for anyone until they turn it on; routines (step 5) will force it.

(c) **Live workers in the chat.** The orchestra's progress card (`TaskProgress`) is now a strip:
collapsed by default, one bullet and "5 workers · 3 running" (plus "· 1 with an error" in red,
so a failure never hides behind it); open, one row per worker (`worker-row.tsx`) with its agent's
icon, its name and the line of what it is doing now, read from the worker's own chat by the pure
`workerActivity()` (`lib/worker-activity.ts`: tool in use, thought in progress, stretch of the
answer being written; for a finished worker, what it last said). A waiting worker keeps its
icon, muted, and says what it waits for; a finished one gets a check; clicking a row opens that
worker's chat. The design was chosen from variation 6C of the design canvas.

Not done in step 4: the message tool between workers (so nothing to show of messages between
them yet) and ephemeral agents created by the orchestrator (step 6). The strip was not looked at
in the real window, and a component-level test is missing because the app has no component test
setup — only the activity logic is tested. In Ask mode a worker still has the question tool, as before.

Not done yet, and deliberately: letting an agent pick which sections it takes. Nothing consumes
the ids except the weight test. Next is choosing the first consumers (for example a profile that
wants `documents` or `memory` but not `visuals`), and only then trimming wording, since that
changes behaviour.

Steps 1–3 carry most of the value at low risk. Steps 4–5 are the large ones; measure token cost
before allowing parallel agents in routines.

Step 6 (ephemeral agents) and the use of the prompt sections are done, with tests; nothing was checked in the real window.

- **Ephemeral agents.** The orchestrator's planning pass has a `define_agent` tool (name, icon, a
  prompt of at most 4,000 characters, optionally a narrower tool list); it returns an
  `agent:eph_…` id that `create_task({agent})` accepts, but only for ids defined by that same chat.
  They live in `agents-ephemeral` (`agents/ephemeral.ts`), apart from the agents list, and are
  never listed or suggested. Rules: only that tool creates them (nothing is read from a tool
  result, a web page or the renderer); at most 5 per chat, 60 in the app, expiring after 30 days;
  they can only narrow — no craft, pinned skills, model, sections or features, so a worker's
  modes still come from its task and the orchestrator's ceiling. The worker row and the chat badge
  show a "Temporary" mark; the badge opens the usual view of the agent with a "Save as agent"
  strip above the prompt. Saving goes through `saveAgent` (the normal validation and limits) and
  leaves `savedAs` on the record, so chats that started with the temporary id keep running the
  saved agent. Not done: dropping a chat's temporary agents when the chat is deleted (they expire
  instead), and the person reading the prompt on the plan card before the plan starts (with
  auto-approve on, workers run first; the prompt is readable from any worker's badge).
- **Sections as a feature.** `AgentInput.sections` lets an agent take parts of the general prompt
  (`identity`, `persona`, `visuals`, `documents`, `memory`) after its own prompt;
  `buildSystemPrompt` filters `buildPromptSections` by those ids. The editor has a switch per part
  with its weight, and the "what a chat injects" view lists the prompt piece by piece (own prompt,
  pinned skills, each taken section) in tokens. Craft agents and built-ins take no sections.
  Weights are measured on the chat-mode general prompt without the tool catalog, so they are
  estimates. The `prompts-weight` ceilings are unchanged: nothing in the general prompt grew. Not
  done: a view of the general chat's own sections (it has no badge to open from).

### 8.6 Open questions

- Whether "promote a worker to a normal subchat" (so the person can keep talking to it) is needed,
  or the worker chat is simply openable from its card.
- The default concurrency limit and budget for routines.
- Whether the catalog shown to the chat is the same list as the orchestrator's, or has its own
  per-agent switch.

### 8.7 Routines as automations (decided, partly built)

A routine is an automation: a **trigger**, a **plan** (one agent, or a team), a **policy**
(limits, budget, failure, permissions) and an **output** (the routine's own screen, a
notification, files). Time is one kind of trigger — the only one with its own controls (days and
a time). Anything else ("when I deploy", "when the price drops") is described in words: the agent
asks what it needs in the chat and builds a script that runs in the background and wakes the
agent only when something fires. It runs only while Orbit is open; that is shown, not hidden.

Decisions:
- **No chat/code switch.** The mode follows the folders: any folder, code; none, chat
  (`routineModeFor`). Folders are optional in both steps of the modal. A team with no folder works
  in a folder of its own per run, where the steps leave their files.
- **Creation is chat-first, the form is the destination of "see details".** A button opens a chat
  with the text ready; the agent asks when the request is vague; a standard proposal card
  (type, state, facts, a dashed note when it runs something on the person's behalf, "see details"
  and "create") confirms. The same card for routine, agent, skill, hook and MCP server. The
  creation chat is archived after the card is answered.
- **A team is optional** (a collapsed section; the common routine is one agent). With one: a
  coordinator (the orchestrator), results pass through dependencies and the run folder, no free
  messages between workers, no approval, a limit of concurrent workers, a token budget and a
  failure policy ("carry on with the others" by default).
- **A run's steps are hidden from the sidebar** (conversations owned by the run) and shown on the
  routine's screen; a step can be opened as a chat.
- **Detail screen adapts** to the kind of routine: tabs for a simple one, stages for a team, a
  watcher with its script and checks, or a timeline of results. Designs: canvas boards 8A–11D.

Step 2 (chat-first creation) is built for routine, agent, skill, MCP server and hook: "create" in
each panel opens a new chat with a sentence to complete (`useStartCreationChat`, fields selected
with Tab), and the five proposal tools now tell the model to ask when the request is vague
(`tools/proposal-guidance.ts`). The standard card (`proposal-card.tsx`) is in use for routine,
agent and skill; "see details" opens the full form filled in for routine and agent. Not done: the
MCP card and the hook's permission card still have their own layout; "see details" for skill, MCP
and hook; archiving the creation chat once the card is answered. The "Ask Orbit" modal was
removed from the panels; the headless generators behind it (`agents/generator.ts`, the hook, MCP
and skill `generate` handlers) are now unused.

Ladder, in order: (1) folders optional, mode derived — **done**; (2) chat-first creation and the
standard card — **done, except the items above**; (3) the detail screen — **done for the single-agent, scheduled routine**: three tabs (overview with the last answer, the numbers and the latest runs; all runs; settings), no chat/code badge, a folder chip only when there are folders. The team stages (11B) and the watcher script (11C) wait for steps 5 and 7; (4) hidden run steps — **done**: the workers of a run no longer nest under it in the sidebar; the routine screen lists them under their run (each opens as a chat). The runs themselves still sit in the sidebar's Routines group, where the running spinner and unread dots live; (5) teams in routines — **engine done**: a routine with the orchestrate mode starts its plan with no approval (`options.orchestrate.unattended`), stops starting workers once `Routine.tokenBudget` is spent, and a failed worker only drops what depends on it (the engine already did that); the concurrency limit is the existing `MAX_PARALLEL`. **Not yet**: the per-run folder for a team with no folder (without folders it still falls back to a plain chat), a UI for the budget, and coordinator-written results (no approval,
budget, failure policy); (6) the editor for the team — **done**: `Routine.team` (members with a name, an instruction, an agent and `dependsOn`; `maxParallel`) plus `tokenBudget`, edited in the create and edit dialogs of a code routine; the scheduler builds the plan from the members (`planFromTeam`) and runs it with `runTeam`, skipping the planning pass. The per-run folder for a team without a folder is still open; (7) event triggers and watchers — **done as generic scripts**:
a routine carries `scripts` (name, summary, code, declared `hosts`, `readFiles`) and an optional
`trigger: { kind: 'script', scriptId, everyMinutes }` that replaces the calendar. The same script
can be the trigger (it checks, calls `fire()`, the agent runs only then) or a tool the agent calls
during a run (`run_script`: read a report template from a spreadsheet, fetch a number from an API).
Scripts run in a worker thread with a null-prototype `vm` context and a JSON-only bridge
(`routines/scripts/`); the main process enforces the abilities (https + declared hosts, read-only
files inside the routine folders, SheetJS for spreadsheets). A script runs only when the person
approved this exact version (`approvedFingerprint` = code + hosts + file access): the form and the
confirmation card approve what they show, an agent's `save_script` never does. The supervisor
(`scripts/supervisor.ts`) runs in the scheduler tick: backoff after failures, "failing" after 3 and
one notification, a 5-minute gap between fires, pending fires kept while the routine is busy, and
the payload reaches the agent fenced as data. **Not yet**: secrets for scripts (public endpoints
only), webhooks (needs a receiver), databases (no drivers; files and HTTP only). On the Scripts tab each script has "Test now"
(runs once, keeps nothing, wakes nobody), "Edit with Orbit" (a chat started on that script) and
"Remove" (not for the trigger script).

**Secrets for scripts.** A script declares `secrets: ['GITHUB_TOKEN']` next to `hosts`; the names are part of `scriptFingerprint` (added only when present, so scripts approved earlier stay approved) and show as chips on the script card. The person stores a secret once, in the Scripts tab (`script-secrets.tsx`); values go to `routines/scripts/secrets-store.ts` (`routine-secrets.json`, encrypted with Electron `safeStorage` when available, else the file's 0600 permission, apart from `auth.json` so exports never carry them). The screen and the agents only ever get names (`routines:secrets:list|set|remove`, `routines_manage` action `list_secrets`); no channel returns a value. A script uses one only through the host: `fetch(url, { auth: { secret, scheme: 'Bearer' | 'Basic' | 'Token', header? } })`. The main process (`secrets-guard.ts`) checks the secret is declared and stored, adds the header after the host check (redirects stay off, so it reaches only a declared host) and scrubs the value — raw, JSON-escaped, URL-encoded and base64 — from the response body, errors, logs, result, fires and state of the run. A server that echoes the token back therefore shows `[secret]`. Limit: a script can still transform data it is allowed to see, but it never sees the token itself, so only a server-side echo of a transformed token could get past the scrubbing.

**Editing a script with Orbit** now opens the chat on the routine's folders (`useStartChatWith(title, starter, folders)`), and `routines_manage` `test_script` takes the `routineId` to try a script against that routine's folders wherever the chat is.

### 8.8 Routine form, agents and one chat per run

- **One chat per run, always.** The "keep every run in one chat" switch and everything behind it
  (`reuseChat`, `chatSessionId`, `rotateChat`, the "chat is full" card) are gone: each execution
  is its own session, listed on the routine screen. Old values in `routines.json` are ignored.
- **The form has two steps** (what and when; who does it and where). Folders are optional and say
  so: without one the routine runs as a chat, with one it can read and edit files. The "describe it
  and a model drafts the routine" step is gone from the desktop (the phone still uses it); creating
  by description happens in the creation chat.
- **A routine is run by one agent or by a team.** `Routine.agent` (`agent:<id>`) opens every run as
  that agent's chat. The agent's features decide the routine's abilities (`applyAgentModes`: vision,
  sub-agents, orchestra, loop, memories); the routine only keeps its autonomy level and, for the
  general setup, its own ability switches. It is read at run time, so editing the agent changes its
  routines.
- **A new creation chat starts from the last chat used** (`inheritChatSettings`): model, thinking
  level, autonomy and modes are copied, then the chat is individual. Removing the model and modes
  defaults from the Preferences altogether (always inherit) is still open.

- **Agents, not "team" (after designs 10A–10C).** The form's second step has an *Agents* section:
  with one it is just which agent does the job; *Add agent* turns it into a team (name, own
  instruction, agent, the agents it waits for, how many at once, a token budget). It is stored as
  `Routine.agent` for one and `Routine.team` for two or more (`lib/agents-draft.ts`). Step 1 is the
  instruction plus *on days and times* / *when something happens*; the second needs questions and a
  script, so it continues in the chat. The name is derived from the instruction and can be edited.
- **The creation chat proposes the split.** `routines_manage` takes a `team` (names, tasks, agent
  ids, dependencies by name; `routines/team-validate.ts` refuses unknown agents, missing
  dependencies and cycles), and its description tells the model to ask once, before creating,
  whether the person wants a team, which pieces could go to specialists, and whether to create
  agents (`create_agent`) for something specific first. A team still needs a folder.

### Scripts and databases (read-only SQLite)

A routine script can query SQLite files with `await db.query(file, sql, params?)` →
`{ columns, rows, truncated }`. The file is declared as `RoutineScript.databases` (paths relative to the
first routine folder), is part of `scriptFingerprint` (added only when present, so earlier approvals stay
valid) and shows in the proposal card and the Scripts tab as "Reads database … (read-only)". `routines_manage`
takes it as `databases` in `scriptSchema`.

**Engines.** SQLite uses the `node:sqlite` built-in of Electron's Node: no native dependency to ship. Postgres
and MySQL are **not built**: a pure-JS driver (`pg`, `mysql2`) is small, but a connection string is a
credential and must come from the secrets work through a host-side lookup, never from the script. The shape
when that lands: `databases` entries gain an engine and a secret name, the host op looks the string up and the
sandbox only ever sees rows. The person's job there is a read-only role, and the card must say so, because
the host cannot prove read-only on a server it does not own.

**Read-only is enforced in layers** (`scripts/sqlite.ts`), none trusting the SQL: the file opens with
`readOnly: true`; an authorizer allows only SELECT, READ, FUNCTION and RECURSIVE, so INSERT/UPDATE/DELETE,
DDL, PRAGMA (read or write), ATTACH, transactions and extension loading are denied; the path must equal a
declared one after both go through `resolveInsideFolders` (symlinks resolved, nothing outside the routine
folders); only the first statement runs (SQLite ignores any tail).
**Limits:** 5 s per query, 5,000 rows, ~2 MB of JSON, 10,000 characters of SQL, 100 bound parameters (text,
number, boolean, null). Blobs come back as `<blob N bytes>`, integers beyond 2^53 as strings. The query runs
in its own worker thread, terminated on timeout, because `node:sqlite` is synchronous and a runaway recursive
query would otherwise freeze the main process.
**Not covered:** a SELECT may read any table of a declared file (no per-table grants); a database that is
being written by another process is read as SQLite allows (WAL files need their `-shm`/`-wal` beside them).

### Webhook trigger for routines

`RoutineTrigger { kind: 'webhook'; signed?: boolean }`: an HTTP request wakes the routine, through
the same `startRun` the script triggers use. Code: `electron/lib/routines/webhooks/`
(`guard.ts` pure rules, `receiver.ts` decisions over a tiny request layer, `store.ts`, `supervisor.ts`
drain into runs, `service.ts` the listener).

**Design.** Orbit is a desktop app with no public address, so the receiver is local and the person
brings the internet.
- *Listener.* One `http` server in the main process, bound to `127.0.0.1` only, on a random port
  (the last port is tried first so the address survives a restart; it changes if that port is
  taken). It exists only while at least one active routine has a webhook trigger: the scheduler
  tick brings it up or down, `stopScheduler` stops it. Request timeout 10 s, headers timeout 5 s,
  one request per connection.
- *Address.* `http://127.0.0.1:<port>/hooks/<token>`; the token is 32 random bytes (base64url), one
  per routine. It is derived (`HMAC(app key, routineId:epoch)`) from a random key kept in
  `orbit-data/.../webhooks/key` (mode 0600), and only its SHA-256 is stored with the routine's
  record, so no file holds a raw token; the routine screen recomputes it to show it.
  "New address" bumps the epoch and the old one dies at once. A wrong token, a paused routine and a
  routine with another trigger all answer the same plain 404.
- *Signature (optional).* `signed: true` generates a per-routine secret (shown on the card) and
  requires `X-Hub-Signature-256: sha256=<hmac-sha256 of the raw body>` (or `X-Orbit-Signature`),
  compared in constant time. Without it the unguessable path is the only credential.
- *Limits.* Body cap 64 KB (checked on `Content-Length` and while streaming; the rest is never
  read), POST only, 20 calls/min per routine, 120/min for the listener, 30/min for addresses that
  do not exist. Accepted payloads are not dropped for being close together: they wait in
  `pending` (max 5, oldest dropped) and ONE run takes everything that gathered, at most one run
  every 5 minutes (`MIN_FIRE_GAP_MS`) and only when the routine is not running.
- *Payload.* JSON with the arrival time, a few safe headers (content type, user agent, event and
  delivery ids; never authorization or cookies) and the body (parsed when JSON), cut to 8000
  characters with `truncated: true`. It reaches the agent fenced as `<event>` data (`event-prompt.ts`,
  wording now says "trigger", not "script").
- *Log.* `WebhookActivity` (last 50 deliveries with accepted/refused reason and size, never the
  content; the pending payloads), pushed as the `webhook-activity` event. Calls to unknown addresses
  are not logged.
- *Internet.* The app never opens a port to the internet and ships no hosted relay. The routine card
  shows the local URL with a copy button and says so; the person points their own tunnel (Cloudflare
  Tunnel, ngrok, Tailscale Funnel…) at it and gives the sender the tunnel's public URL plus the
  path. Only works while Orbit is open.
- *Agent.* `routines_manage` "create" takes `webhook: { signed? }` (excluded with a script
  `trigger`); the proposal card note states exactly what listens (127.0.0.1, random port, while Orbit
  is open, nothing exposed). `approvePendingRoutine` now also carries `scripts` and `trigger`.

**Not done / the person's call.** A tunnel integration (bundling one or managing its process) is a
product and security decision and was left out; so were a configurable port, a per-sender allowlist
and replay protection (the signature has no timestamp). Calls arriving while Orbit is closed are lost.

### Orchestra engine: scratch folder, unattended review, estimate, teammate notes

- **Folder per run.** A routine with a team and no folder gets `<userData>/orbit-data/routine-runs/<routine id>/<yyyy-mm-dd_hh-mm-ss>` per execution (`routines/run-folder.ts`), used as the working directory of the run, kept afterwards and stored on `RoutineRun.folder`; the run row has an "Open the folder of this run" link. Such a run's chat is a code session (it has a directory). Only in a scratch folder do the members get a handoff note (`planFromTeam(..., { handoff: true })`): each writes its complete result to `<member-name>.md` and reads the files of the members it waits for, besides the cut summary the engine already passes. In a real project folder nothing extra is written. The create and edit dialogs now offer the team without a folder.
- **Review in unattended runs.** `settingsForUnattended` (`orchestration/unattended.ts`) forces the orchestra behaviour `orchestrate` (no model review of each worker) for a routine's team, whatever the global supervise/rigorous setting. `Routine.review` opts in: the global behaviour then applies, and `orchestrate` is raised to `supervise`. Default off, because nobody is watching a routine, and a review makes cost and duration unpredictable. The flag travels as `options.orchestrate.unattended.review`.
- **Estimate.** `src/lib/team-estimate.ts`: with history, the range of the last 5 successful runs (one run is widened by 25%); without, 20-60k tokens per member plus 10-20k for the closing summary, a third more with review; rounded outward to 10k. Shown in the agents editor (`AgentsEditor`), with its basis stated.
- **Teammate notes.** `message_teammate` (`tools/teammates.ts`, backed by `orchestration/mailbox.ts`): a worker leaves a note for another worker of the same plan. Limits: same plan only, 600 characters, 8 messages per sender, 2 s between messages, 4 unread per recipient, nothing to a worker that finished. Delivered with the first prompt if the recipient has not started, otherwise added to its context at its next step (kept for the rest of that turn). No reply is awaited; results still go in files.
- **Not done / merge notes.** `routines_manage` accepts a team only when the chat has folders (that guard lives in the uncommitted `tools/routines.ts`); remove that refusal and the scratch folder covers the rest. The proposal card cannot yet carry `review`.

- **A routine's team is a contract.** In an unattended run (`options.orchestrate.unattended`) the
  reviewer, when the routine opted into review, can accept, ask the same worker again within the
  adjustment budget, or mark it failed; it cannot add workers (`fixedTeam` in `reviewer.ts` and
  `execution.ts`). Review stays off by default.
