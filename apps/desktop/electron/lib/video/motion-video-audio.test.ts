import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { motionVideoAudioTracks, videoFileIn, type MotionVideoFact } from './motion-video-audio'

const folder = path.join('/tmp', 'piece')
const fact = (over: Partial<MotionVideoFact> = {}): MotionVideoFact => ({
  src: 'orbit-motion://mv_abc/clip.mp4',
  muted: false,
  loop: false,
  gain: 0,
  start: 0,
  in: 0,
  ...over,
})
const yes = async () => true

describe('videoFileIn', () => {
  it('lê a URL do scheme e o caminho relativo, decodificando', () => {
    expect(videoFileIn(folder, 'orbit-motion://mv_abc/clip.mp4')).toBe(path.join(folder, 'clip.mp4'))
    expect(videoFileIn(folder, 'orbit-motion://mv_abc/sub%20dir/a%20b.mp4?r=3')).toBe(path.join(folder, 'sub dir', 'a b.mp4'))
    expect(videoFileIn(folder, 'media/clip.mp4#t=2')).toBe(path.join(folder, 'media', 'clip.mp4'))
  })

  it('recusa o que está fora da pasta ou não é do scheme', () => {
    expect(videoFileIn(folder, '../outro/clip.mp4')).toBeNull()
    // O parser de URL já colapsa os `..`: o que sobra cai DENTRO da pasta, nunca fora.
    expect(videoFileIn(folder, 'orbit-motion://mv_abc/../../etc/passwd')).toBe(path.join(folder, 'etc', 'passwd'))
    expect(videoFileIn(folder, 'https://cdn.example.com/clip.mp4')).toBeNull()
    expect(videoFileIn(folder, '')).toBeNull()
    expect(videoFileIn(folder, '%E0%A4%A')).toBeNull()
  })
})

describe('motionVideoAudioTracks', () => {
  it('um vídeo com som vira uma faixa do plano, no tempo dele', async () => {
    const [track] = await motionVideoAudioTracks(folder, [fact({ start: 2, in: 5, end: 9, gain: -6 })], yes)
    expect(track).toMatchObject({
      file: path.join(folder, 'clip.mp4'),
      name: 'clip.mp4 (video)',
      path: 'clip.mp4',
      start: 2,
      end: 9,
      offset: 5,
      gainDb: -6,
      duck: false,
    })
    expect(track.fx).toEqual({ eq: [], automation: [] })
    expect(track).not.toHaveProperty('loop')
  })

  it('o padrão não traz recorte nenhum — é a faixa inteira desde o zero', async () => {
    const [track] = await motionVideoAudioTracks(folder, [fact()], yes)
    expect(track).toMatchObject({ start: 0 })
    expect(track).not.toHaveProperty('end')
    expect(track).not.toHaveProperty('offset')
  })

  it('vídeo calado não soa: atributo muted ou data-audio="false"', async () => {
    expect(await motionVideoAudioTracks(folder, [fact({ muted: true })], yes)).toEqual([])
  })

  it('sem faixa de áudio no arquivo, ou ffprobe que falha, não gera nada nem derruba', async () => {
    expect(await motionVideoAudioTracks(folder, [fact()], async () => false)).toEqual([])
    expect(
      await motionVideoAudioTracks(folder, [fact()], async () => {
        throw new Error('ffprobe')
      }),
    ).toEqual([])
  })

  it('fora da pasta ou de outro lugar fica de fora', async () => {
    const facts = [fact({ src: '../x.mp4' }), fact({ src: 'https://a/b.mp4' })]
    expect(await motionVideoAudioTracks(folder, facts, yes)).toEqual([])
  })

  it('o mesmo arquivo com o mesmo recorte soa uma vez; recortes diferentes soam cada um', async () => {
    const tracks = await motionVideoAudioTracks(folder, [fact(), fact(), fact({ start: 4 })], yes)
    expect(tracks.map((t) => t.start)).toEqual([0, 4])
  })

  it('loop é repassado e end antes do start é ignorado', async () => {
    const [looped] = await motionVideoAudioTracks(folder, [fact({ loop: true })], yes)
    expect(looped.loop).toBe(true)
    const [bad] = await motionVideoAudioTracks(folder, [fact({ start: 5, end: 2 })], yes)
    expect(bad).not.toHaveProperty('end')
  })

  it('sem retrato nenhum não há faixa', async () => {
    expect(await motionVideoAudioTracks(folder, undefined, yes)).toEqual([])
  })
})
