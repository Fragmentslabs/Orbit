import type { ToolSet } from 'ai'
import type { BuiltinOverride } from '@shared/agents'
import type { SpecialistProfile } from '@shared/chat'
import { pinnedSkillsBlock } from '../agents/pinned-skills'
import { getAppSettings } from '../app-settings'
import { resolveFfmpeg } from '../video/ffmpeg'
import { fragmentSystemPrompt, fragmentTurnBlock } from '../fragments/fragment-profile'
import { familyGuide } from '../skills/builtin'
import { createAudioGenerateTool, createSfxGenerateTool } from '../tools/audio'
import { createDesignTools } from '../tools/design'
import { createFontTools } from '../tools/fonts'
import { createFragmentTools } from '../tools/fragment'
import { createQuestionTool } from '../tools/question'
import { createMotionTools } from '../tools/motion'
import { designTurnBlock, motionTurnBlock } from './turn-blocks'
import { CRAFT_BLOCKS, type ProfileDefinition } from './types'

/**
 * The profiles that ship with Orbit. Each is a definition like any other (see types.ts);
 * adding a craft means adding one entry here and its descriptor in artifacts/kinds.ts.
 */

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

const fragment: ProfileDefinition = {
  id: 'fragment',
  builtin: true,
  whenToUse: 'Building or changing a small custom screen or panel that lives inside Orbit.',
  systemPrompt: ({ language }) => fragmentSystemPrompt(language),
  tools: (input) => ({ ...createFragmentTools(input.sessionId), question: createQuestionTool(input) }),
  blocks: CRAFT_BLOCKS,
  turnBlock: fragmentTurnBlock,
  turnContext: 'The fragment being worked on: name, id, kind, revision, files and what it asked for.',
}

const motion: ProfileDefinition = {
  id: 'motion',
  builtin: true,
  whenToUse: 'Making or refining an animation, motion graphic or video piece.',
  systemPrompt: ({ language }) => [MOTION_ROLE, '', replyLine(language), '', familyGuide('motion') ?? ''].join('\n').trim(),
  tools: (input, modelVision) => {
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
  },
  blocks: CRAFT_BLOCKS,
  turnBlock: motionTurnBlock,
  turnContext: 'The compositions of the conversation (and the one in focus), plus what the person has selected and where the playhead is in the Motion tab.',
}

const design: ProfileDefinition = {
  id: 'design',
  builtin: true,
  whenToUse: 'Designing a screen, layout, logo or poster on a canvas.',
  systemPrompt: ({ language }) => [DESIGN_ROLE, '', replyLine(language), '', familyGuide('design') ?? ''].join('\n').trim(),
  tools: (input) => ({ ...createDesignTools({ sessionId: input.sessionId }), ...createFontTools() }),
  blocks: CRAFT_BLOCKS,
  turnBlock: designTurnBlock,
  turnContext: 'The canvases of the conversation (and the one in focus), plus the active artboard and the selection in the Design tab.',
}

export const BUILTIN_DEFINITIONS: Record<SpecialistProfile, ProfileDefinition> = { fragment, motion, design }

/**
 * A built-in with the person's changes layered on. A custom prompt REPLACES the whole shipped
 * system prompt (the editor starts from it), while the craft's tools and turn context stay as
 * shipped; pinned skills are appended after it.
 */
export function withOverride(base: ProfileDefinition, override: BuiltinOverride | undefined): ProfileDefinition {
  const pinned = override?.pinnedSkills ?? base.pinnedSkills ?? []
  const customPrompt = override?.prompt?.trim()
  if (!override) return { ...base, pinnedSkills: pinned }
  return {
    ...base,
    whenToUse: override.whenToUse ?? base.whenToUse,
    pinnedSkills: pinned,
    systemPrompt: (input) =>
      [customPrompt || base.systemPrompt(input), pinnedSkillsBlock(pinned)].filter(Boolean).join('\n\n'),
  }
}
