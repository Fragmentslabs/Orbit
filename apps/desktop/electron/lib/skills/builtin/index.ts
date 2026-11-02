import type { Skill } from '@shared/skills'
import { parseSkill } from '../parser'
import inlineUi from './inline-ui.md?raw'
import mediaCompress from './media-compress.md?raw'
import webRecon from './web-recon.md?raw'
import guideArtifacts from './guides/artifacts.md?raw'
import guideDesign from './guides/design.md?raw'
import guideDocuments from './guides/documents.md?raw'
import guideImage from './guides/image.md?raw'
import guideMedia from './guides/media.md?raw'
import guideMotion from './guides/motion.md?raw'
import guideSlides from './guides/slides.md?raw'
import guideSvg from './guides/svg.md?raw'
import guideVideo from './guides/video.md?raw'
import guideYtdlp from './guides/ytdlp.md?raw'

/**
 * Built-in skills of the app: they read the same format as the user's skills
 * (frontmatter + markdown), but they are read-only and take no space on the
 * user's disk. A global or project skill with the same slug overrides the built-in.
 */

interface BuiltinSource {
  raw: string
  path: string
}

/**
 * Family guides: the manual of a tool family, keyed by family id. They are
 * skills so `skill_read` / `skill_search` reach them like any other, but the
 * prompt never lists them — `tools_load` delivers the guide with the family
 * (see tools/guides.ts), which is the moment between loading and the first call.
 */
const GUIDE_SOURCES: Record<string, string> = {
  artifacts: guideArtifacts,
  design: guideDesign,
  documents: guideDocuments,
  image: guideImage,
  media: guideMedia,
  motion: guideMotion,
  slides: guideSlides,
  svg: guideSvg,
  video: guideVideo,
  ytdlp: guideYtdlp,
}

const SOURCES: BuiltinSource[] = [
  { raw: webRecon, path: 'builtin://web_recon' },
  { raw: mediaCompress, path: 'builtin://media_compress' },
  { raw: inlineUi, path: 'builtin://inline_ui' },
  ...Object.entries(GUIDE_SOURCES).map(([family, raw]) => ({ raw, path: `builtin://guides/${family}` })),
]

export const BUILTIN_SKILLS: Skill[] = SOURCES.flatMap(({ raw, path }) => {
  const skill = parseSkill(raw, 'builtin', path)
  if (!skill) {
    console.error(`[skills] invalid built-in skill: ${path}`)
    return []
  }
  return [skill]
})

/** Guide body of a family (`undefined` = the family has no guide). */
export function familyGuide(familyId: string): string | undefined {
  const raw = GUIDE_SOURCES[familyId]
  return raw ? BUILTIN_SKILLS.find((s) => s.filePath === `builtin://guides/${familyId}`)?.content : undefined
}

/** Built-in skills that are family guides — kept out of the prompt's skill index. */
export function isFamilyGuide(skill: { filePath?: string }): boolean {
  return skill.filePath?.startsWith('builtin://guides/') ?? false
}
