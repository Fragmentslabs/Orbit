import type { RoutineModes, Schedule } from './routines'

/**
 * Maintenance routines shipped with Orbit, created DISABLED.
 *
 * They exist because the two things that pile up the most — old chats and
 * forgotten memories — have no automatic cleanup today: the Brain cleanup only
 * reaches memories with an expiry (seasonal and project/context), which are the
 * minority, and chats are never touched.
 *
 * Both are CHAT mode, and that is deliberate: neither needs to read files.
 * Consolidating memories touches ids (memory_list / memory_update /
 * memory_delete / memory_link), not code — giving them a working folder would
 * grant disk reads for nothing. As a consequence, consolidation cannot VERIFY
 * obsolescence, and the prompts forbid concluding it: that is the job of a
 * code routine, per project, which the user assembles whenever they want.
 *
 * The prompts are written in English (like the other prompts of the product)
 * and tell the agent to answer in the user's language — the app language
 * travels with the run's session and reaches the agent.
 *
 * Both tell the agent to ARCHIVE/consolidate, never delete by default. The user
 * can rewrite the prompt to delete — the tools support it —, but that becomes
 * their explicit choice, not the factory behaviour of something that runs on
 * its own.
 */

export interface DefaultRoutine {
  /**
   * Stable identity — marks that this preset has already been seeded once. The ids of the
   * presets below are persisted in routines.json and are kept exactly as they were first
   * written on purpose: renaming one makes the seeder treat it as a new preset and create a
   * duplicate routine for everybody who already has it. `title` is the editable, user-facing
   * field and is free to change.
   */
  id: string
  title: string
  prompt: string
  schedule: Schedule
  modes: RoutineModes
  mode: 'chat' | 'code'
}

const MAINTENANCE_MODES: RoutineModes = {
  loop: true,
  subagents: false,
  orchestrate: false,
  brain: true,
  browser: false,
  search: false,
  vision: false,
  plan: false,
  simple: false,
}

export const DEFAULT_ROUTINES: DefaultRoutine[] = [
  {
    id: 'padrao:limpeza-chats',
    title: 'Archive inactive chats',
    schedule: { time: '03:00', days: [1] },
    modes: MAINTENANCE_MODES,
    mode: 'chat',
    prompt: `Archive chats that fell out of use, so the sidebar stays readable.

You run unattended, with nobody to ask. Do not ask questions and do not request approval.
Write your reply in the user's language.

STEPS
1. Call chat_list with inactiveDays=30 to see chats untouched for 30 days or more.
   The tool already leaves out what is not a candidate: pinned chats, chats that
   are already archived, orchestration sub-sessions and routine runs.
2. Read the titles. Archive with chat_archive the ones that clearly served their
   purpose — one-off questions already answered, throwaway tests, single-exchange
   conversations, generic titles like "New chat".
3. Do NOT archive anything that looks like living reference: architecture
   decisions, long investigations, any chat whose title suggests it will be
   consulted again. When unsure, leave it alone — erring towards keeping costs
   almost nothing.
4. Reply with a summary: how many you archived and their titles, plus how many
   you looked at and decided to keep, with a one-line reason each.

RULES
- ARCHIVE, NEVER DELETE. Archiving is reversible: the chat leaves the sidebar,
  its messages stay intact, and it returns to its place if unarchived. The
  chat_delete tool exists, but erasing the user's own messages is not something
  an unattended routine should decide on its own.
- An archived chat keeps its folder, so there is nothing to move.
- Do not touch files, do not run commands, do not change anything but the chats.`,
  },
  {
    id: 'padrao:limpeza-memorias',
    title: 'Consolidate memories',
    schedule: { time: '03:30', days: [1] },
    modes: MAINTENANCE_MODES,
    mode: 'chat',
    prompt: `Review the stored memories: merge what is duplicated and reconnect what got
orphaned. Only memories with an expiry are cleaned automatically, and those are
the minority — everything else piles up with nobody ever reviewing it.

You run unattended, with nobody to ask. Do not ask questions and do not request approval.
Write your reply in the user's language.

STEPS
1. Call memory_list with includeProjectMemories=true to see what fell into
   disuse across every project. It sorts from least used to most used and shows
   hits, age and last use. memory_search is the wrong tool here: it ranks by
   lexical relevance and therefore hides exactly the forgotten memories you are
   looking for.
2. Look for DUPLICATES: two or more memories saying the same thing in different
   words. For each group pick the one with the most hits and the most
   connections, and rewrite its text with memory_update so it absorbs whatever
   the others added. Only then delete the absorbed ones with memory_delete.
   Preferring update over delete is not a detail: the surviving memory keeps its
   id, its links and its accumulated usage, all of which deleting throws away.
3. Look for ORPHANS: call memory_list with onlyOrphans=true. Connect the ones
   that still make sense with memory_link, hanging each off the memory it
   belongs with.
4. Fix MISCLASSIFICATION: a memory saved as kind="general" whose text names a
   specific project's entities, schema, routes or business rules belongs to that
   project. Correct it with memory_update.
5. Reply with a summary: what was merged (text before and after), what was
   deleted and why, and what was reconnected.

RULES
- NEVER merge memories from different projects. Similar wording across projects
  is shared vocabulary, not duplication — two "Project Overview" memories
  describe different projects and must stay separate. Check projectId before
  concluding two memories are the same.
- You CANNOT verify obsolescence. This routine has no working folder and cannot
  read code, so never delete something for "looking outdated" — you have no way
  to confirm it. Delete only what is redundant (absorbed in step 2) or plainly
  self-contradictory.
- Low usage is NOT a reason to delete. A rarely needed convention is still
  correct when its subject comes up.
- When unsure whether two memories are duplicates, keep both. Merging wrongly
  loses information and nobody notices.
- Do not touch files and do not run commands.`,
  },
]
