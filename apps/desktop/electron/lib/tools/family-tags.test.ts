import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import { classifyFamilies } from './catalog'
import { familiesMentionedInText } from './active'

const TOOLS = {
  read: {},
  tools_load: {},
  motion_write: {},
  video_probe: {},
  media_compress: {},
  ytdlp_download: {},
  pdf_merge: {},
  doc_create: {},
  design_write: {},
  slides_write: {},
  svg_create: {},
  skill_read: {},
} as unknown as ToolSet

const input = {
  mode: 'code',
  text: '',
  options: { plan: false, browser: false, research: false, brain: false, subagents: false },
} as unknown as SendMessageInput

const families = classifyFamilies(TOOLS, input)
const mention = (text: string) => familiesMentionedInText(text, families)

describe('family tags', () => {
  it('loads a family by a curated tag, accents folded on both sides', () => {
    expect(mention('faz uma animação do logo')).toContain('motion')
    expect(mention('faz uma animacao do logo')).toContain('motion')
    expect(mention('baixa esse vídeo do youtube')).toContain('ytdlp')
    expect(mention('junta esses PDF em um só')).toContain('documents')
    expect(mention('põe legenda no clipe')).toContain('video')
  })

  it('matches whole words only', () => {
    expect(mention('o pdfs')).not.toContain('documents')
    expect(mention('a slideshow inteira')).not.toContain('slides')
  })

  it('matches a tag with spaces as a phrase', () => {
    expect(mention('quero baixar   vídeo disso')).toContain('ytdlp')
    expect(mention('baixar e ver o vídeo')).not.toContain('ytdlp')
  })

  it('stays quiet on everyday messages', () => {
    for (const text of [
      'faz um commit e dá push',
      'corte de gastos pela metade',
      'uma proposta de nome',
      'logo depois a gente vê',
      'qual a capital da França',
      'um vídeo bonito',
      'me explica essa função',
    ]) {
      expect(mention(text), text).toEqual([])
    }
  })

  it('never shares a tag between two families', () => {
    const seen = new Map<string, string>()
    for (const family of families) {
      for (const tag of family.tags ?? []) {
        const key = tag.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
        expect(seen.get(key), `${tag} in ${family.id}`).toBeUndefined()
        seen.set(key, family.id)
      }
    }
  })
})
