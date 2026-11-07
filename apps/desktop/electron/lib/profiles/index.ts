import fsp from 'node:fs/promises'
import type { ToolSet } from 'ai'
import {
  StorageKeys,
  specialistProfileOf,
  type SendMessageInput,
  type SendMessageOptions,
  type SessionInfo,
  type SpecialistProfile,
} from '@shared/chat'
import { getAppSettings } from '../app-settings'
import { resolveFfmpeg } from '../video/ffmpeg'
import { readJson } from '../storage'
import { fragmentSystemPrompt, fragmentTurnBlock } from '../fragments/fragment-profile'
import { familyGuide } from '../skills/builtin'
import { createAudioGenerateTool, createSfxGenerateTool } from '../tools/audio'
import { createDesignTools, designPiecesDir } from '../tools/design'
import { createFontTools } from '../tools/fonts'
import { createFragmentTools } from '../tools/fragment'
import { createMotionTools, motionPiecesDir } from '../tools/motion'

/**
 * Specialist profiles: a chat that exists for ONE craft runs with the setup of that craft
 * instead of the general one.
 *
 * A general chat carries a long system prompt, memories, skills and dozens of tools. For a
 * narrow job most of that is noise, and what actually matters (the format, the rules, the
 * mistakes) gets diluted. A profile replaces it for the whole conversation with:
 *  - a focused system prompt that carries the craft's knowledge,
 *  - only the craft's tools,
 *  - a per-turn block with the state of the artifact being worked on,
 *  - none of the usual blocks (memories, skills, project context, subchats).
 *
 * The profile is decided HERE, from the session on disk — never trusted from the UI — and
 * is fixed for the life of the conversation.
 */

/** The profile of a session, read from disk at the start of a turn (null = a general chat). */
export async function profileOf(sessionId: string): Promise<SpecialistProfile | null> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  return specialistProfileOf(session)
}

/** Switches off everything a specialist chat does not use. */
export function leanOptions(options: SendMessageOptions, profile: SpecialistProfile): SendMessageOptions {
  return {
    ...options,
    profile,
    brainContext: false,
    research: false,
    browser: false,
    computer: false,
    subagents: false,
    orchestrate: undefined,
    plan: false,
  }
}

/** True when the turn runs a specialist profile (the blocks of a general chat are skipped). */
export function isSpecialistTurn(input: Pick<SendMessageInput, 'options'>): boolean {
  return Boolean(input.options.profile)
}

const MOTION_ROLE = [
  "You are Orbit's motion designer. You make animation as motion pieces and refine them live while the person watches the Motion tab next to this conversation.",
  '',
  'How you work:',
  '- Direction before code: decide the shot list (what appears, in what order, how long), the easing and the hierarchy of attention. A piece with no direction looks generic.',
  '- Create with motion_write, then change it with motion_edit (small, exact replacements). The tab reloads on every write; reuse the same name to keep iterating.',
  '- Look at a few key frames with motion_frame when the question is visual (timing, overlap, crop), not after every edit. Render the video only when the person asks.',
  '- Start with a complete, good-looking first version, then improve it. Do not ask what a sensible default answers.',
  '- You only work on animation. You have no other tools, and that is on purpose.',
].join('\n')

const DESIGN_ROLE = [
  "You are Orbit's visual designer. You make screens, layouts, logos and posters as design canvases and refine them live while the person watches the Design tab next to this conversation.",
  '',
  'How you work:',
  '- Decide the look first: type, color, spacing, one clear idea. A design with no point of view looks generic.',
  '- Create with design_write, then change it with design_edit (small, exact replacements). The canvas reloads on every write; reuse the same name to keep iterating.',
  '- Judge the result by how it looks: check it visually once when the question is visual, not after every edit.',
  '- Start with a complete, good-looking first version, then improve it. Do not ask what a sensible default answers.',
  '- You only work on design. You have no other tools, and that is on purpose.',
].join('\n')

function replyLine(language?: string): string {
  return language
    ? `Reply in ${language}, briefly: say what you made or changed in one or two sentences.`
    : 'Reply in the language of the request, briefly: say what you made or changed in one or two sentences.'
}

/** The system prompt of a specialist chat — and nothing else (no general blocks). */
export function profileSystemPrompt(profile: SpecialistProfile, input: Pick<SendMessageInput, 'language'>): string {
  switch (profile) {
    case 'fragment':
      return fragmentSystemPrompt(input.language)
    case 'motion':
      return [MOTION_ROLE, '', replyLine(input.language), '', familyGuide('motion') ?? ''].join('\n').trim()
    case 'design':
      return [DESIGN_ROLE, '', replyLine(input.language), '', familyGuide('design') ?? ''].join('\n').trim()
  }
}

/** The tools of the craft — the whole toolset of a specialist chat. */
export function profileTools(profile: SpecialistProfile, input: SendMessageInput, modelVision?: boolean): ToolSet {
  switch (profile) {
    case 'fragment':
      return { ...createFragmentTools(input.sessionId) }
    case 'motion': {
      const voice = getAppSettings().voice
      const tools: ToolSet = {
        ...createMotionTools({
          sessionId: input.sessionId,
          modelVision: modelVision !== false,
          canRender: resolveFfmpeg() !== null,
          language: input.language,
          sttEnabled: voice.stt.enabled,
        }),
        ...createFontTools(),
        sfx_generate: createSfxGenerateTool(input.sessionId, null),
      }
      if (voice.tts.enabled) tools.audio_generate = createAudioGenerateTool(input.sessionId, null)
      return tools
    }
    case 'design':
      return { ...createDesignTools({ sessionId: input.sessionId }), ...createFontTools() }
  }
}

/**
 * A chat made for an artifact that already exists (from its card) is told which one. Motion
 * and design pieces live in the folder of the chat that made them, so the id is how another
 * chat reaches the same piece.
 */
async function focusLine(kind: 'motion' | 'design', sessionId: string): Promise<string> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  const id = session?.artifact?.kind === kind ? session.artifact.id : undefined
  return id
    ? `Artifact in focus: id ${id}. It was made in another conversation: pass this id as \`id\` to the ${kind} tools to read and change it.`
    : ''
}

async function namesIn(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'renders').map((e) => e.name)
}

/** What this turn needs to know about the artifact: per turn, in the user message. */
export async function profileTurnBlock(profile: SpecialistProfile, sessionId: string): Promise<string> {
  switch (profile) {
    case 'fragment':
      return fragmentTurnBlock(sessionId)
    case 'motion': {
      const names = await namesIn(motionPiecesDir(sessionId))
      const focus = await focusLine('motion', sessionId)
      return [
        '<motion-context>',
        ...(focus ? [focus] : []),
        names.length
          ? `Compositions in this conversation: ${names.join(', ')}. Read one with motion_read before changing it.`
          : 'No composition exists in this conversation yet. Create one with motion_write.',
        '</motion-context>',
      ].join('\n')
    }
    case 'design': {
      const names = await namesIn(designPiecesDir(sessionId))
      const focus = await focusLine('design', sessionId)
      return [
        '<design-context>',
        ...(focus ? [focus] : []),
        names.length
          ? `Canvases in this conversation: ${names.join(', ')}. Read one with design_read before changing it.`
          : 'No canvas exists in this conversation yet. Create one with design_write.',
        '</design-context>',
      ].join('\n')
    }
  }
}
