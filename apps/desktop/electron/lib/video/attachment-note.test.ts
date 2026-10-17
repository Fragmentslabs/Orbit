import { describe, expect, it } from 'vitest'
import type { MediaProbe } from './ffmpeg'
import { describeVideoFacts, imageRefLine, videoAttachmentNote } from './attachment-note'

const probe = (over: Partial<MediaProbe> = {}): MediaProbe => ({
  file: '/x/a.mp4',
  durationMs: 754_300,
  sizeBytes: 382_000_000,
  format: 'mov,mp4',
  video: [{ index: 0, codec: 'h264', width: 3840, height: 2160, fps: 29.97, rotation: 0, pixFmt: 'yuv420p' }],
  audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
  display: { width: 3840, height: 2160 },
  ...over,
})

describe('describeVideoFacts', () => {
  it('uma linha: duração, resolução, fps, áudio e tamanho', () => {
    expect(describeVideoFacts(probe())).toBe('754.3 s, 3840x2160 @ 29.97 fps, audio 2ch, 382.0 MB')
  })

  it('sem áudio é dito com todas as letras; sem sondagem, que não foi possível ler', () => {
    expect(describeVideoFacts(probe({ audio: [] }))).toContain('NO audio')
    expect(describeVideoFacts(null)).toMatch(/Could not read/)
  })

  it('usa a resolução EXIBIDA (rotação aplicada), não a do stream', () => {
    const rotated = probe({
      video: [{ index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30, rotation: 90, pixFmt: 'yuv420p' }],
      display: { width: 1080, height: 1920 },
    })
    expect(describeVideoFacts(rotated)).toContain('1080x1920')
  })
})

describe('videoAttachmentNote', () => {
  const note = videoAttachmentNote({ filename: 'Aula.mp4', id: 'vdo_ab12.mp4', file: '/app/video-attachments/vdo_ab12.mp4', probe: probe() })

  it('é curta e não carrega conteúdo: referência, arquivo e uma linha de fatos', () => {
    expect(note.split('\n')).toHaveLength(4)
    expect(note.length).toBeLessThan(900)
    expect(note).toContain('[Video attached: Aula.mp4 — ref vdo_ab12.mp4]')
    expect(note).toContain('754.3 s, 3840x2160')
  })

  it('diz que NÃO foi assistido nem transcrito e quando ler cada coisa', () => {
    expect(note).toContain('NOT watched and NOT transcribed')
    expect(note).toContain('video_transcribe for what is SAID')
    expect(note).toContain('video_timeline')
    expect(note).toContain('motion_asset')
    expect(note).toContain('only if the request is about using this video')
  })

  it('vídeo sem áudio não oferece transcrever', () => {
    const silent = videoAttachmentNote({ filename: 'a.mp4', id: 'vdo_x.mp4', file: '/f', probe: probe({ audio: [] }) })
    expect(silent).not.toContain('video_transcribe')
  })

  it('um problema substitui o resto: sem referência utilizável', () => {
    const refused = videoAttachmentNote({ filename: 'a.mp4', id: 'unavailable', file: '', probe: null, problem: 'The file is not a readable video.' })
    expect(refused).toBe('[Video attached: a.mp4 — ref unavailable]\n(The file is not a readable video.)')
  })
})

describe('imageRefLine', () => {
  it('dá a referência da imagem guardada; o GIF é dito como animado', () => {
    expect(imageRefLine('orbit-media://img_ab12.png', 'foto.png', 'image/png')).toBe(
      '[Image file: foto.png — ref img_ab12.png] (to place it in a motion piece call motion_asset with this ref; otherwise ignore this line.)',
    )
    expect(imageRefLine('orbit-media://img_cd34.gif', 'dança.gif', 'image/gif')).toContain('GIF (animated)')
    expect(imageRefLine('orbit-media://img_cd34.gif', 'sem-mime.gif', '')).toContain('GIF (animated)')
  })

  it('sem imagem guardada não há linha nenhuma', () => {
    expect(imageRefLine(undefined, 'a.png', 'image/png')).toBe('')
  })
})
