import { describe, expect, it } from 'vitest'
import {
  MAX_MOTION_BANDS,
  assertFrameBytes,
  bandCount,
  concatFfmpegArgs,
  concatList,
  expectedFrameBytes,
  isMotionAudioFile,
  isPlainAudioEvent,
  isPlainAudioMix,
  motionAudioCodec,
  motionAudioFfmpegArgs,
  motionAudioMixFfmpegArgs,
  motionEncoderArgs,
  motionFfmpegArgs,
  motionFormatExt,
  motionFormatFor,
  normalizeMotionFormat,
  rawVideoFilters,
  splitBands,
  unpremultiplyBgra,
} from './motion-render-args'

/** Argumentos de uma faixa com o quadro do tamanho da captura (sem HiDPI). */
function args(format: Parameters<typeof motionFfmpegArgs>[0]['format'], capture = { width: 1920, height: 1080 }) {
  return motionFfmpegArgs({
    width: 1920,
    height: 1080,
    captureWidth: capture.width,
    captureHeight: capture.height,
    fps: 30,
    format,
    output: 'out.mp4',
  })
}

/** Um buffer BGRA a partir de pixels [b, g, r, a]. */
function bgra(pixels: Array<[number, number, number, number]>): Buffer {
  const buffer = Buffer.alloc(pixels.length * 4)
  pixels.forEach(([b, g, r, a], i) => {
    buffer[i * 4] = b
    buffer[i * 4 + 1] = g
    buffer[i * 4 + 2] = r
    buffer[i * 4 + 3] = a
  })
  return buffer
}

const pixel = (buffer: Buffer, i = 0): number[] => [buffer[i * 4], buffer[i * 4 + 1], buffer[i * 4 + 2], buffer[i * 4 + 3]]

describe('formato de saída', () => {
  it('motionFormatFor deriva do arquivo + transparência', () => {
    expect(motionFormatFor('out.mp4', false)).toBe('mp4')
    expect(motionFormatFor('out.webm', false)).toBe('webm')
    // `.mov` sem transparência continua sendo H.264, como antes.
    expect(motionFormatFor('out.mov', false)).toBe('mp4')
    expect(motionFormatFor('out.mov', true)).toBe('mov-alpha')
    expect(motionFormatFor('out.webm', true)).toBe('webm-alpha')
    expect(() => motionFormatFor('out.mp4', true)).toThrow(/transparent output/)
  })

  it('normalizeMotionFormat aceita o contrato congelado e os nomes antigos', () => {
    expect(normalizeMotionFormat(undefined)).toBe('mp4')
    expect(normalizeMotionFormat('mp4')).toBe('mp4')
    expect(normalizeMotionFormat('mov-alpha')).toBe('mov-alpha')
    expect(normalizeMotionFormat('webm-alpha')).toBe('webm-alpha')
    // Nomes antigos do IPC.
    expect(normalizeMotionFormat('mov')).toBe('mov-alpha')
    expect(normalizeMotionFormat('webm')).toBe('webm')
    expect(normalizeMotionFormat('webm', true)).toBe('webm-alpha')
    // O nome `-alpha` manda, mesmo sem a flag de transparência.
    expect(normalizeMotionFormat('webm-alpha', false)).toBe('webm-alpha')
    expect(() => normalizeMotionFormat('gif')).toThrow(/unsupported motion format: gif/)
  })

  it('extensão e formato de pixel de cada saída', () => {
    expect(motionFormatExt('mp4')).toBe('.mp4')
    expect(motionFormatExt('mov-alpha')).toBe('.mov')
    expect(motionFormatExt('webm')).toBe('.webm')
    expect(motionFormatExt('webm-alpha')).toBe('.webm')
  })
})

describe('argumentos do ffmpeg', () => {
  it('raw: o stdin é rawvideo BGRA com o tamanho da captura, sem PNG', () => {
    const line = args('mp4').join(' ')
    expect(line).toContain('-f rawvideo -pix_fmt bgra -s 1920x1080 -framerate 30 -i pipe:0')
    // O caminho antigo (PNG por quadro) não pode sobrar em lugar nenhum.
    expect(line).not.toContain('png')
    expect(line).not.toContain('image2pipe')
    // Captura já no tamanho final: nenhum scale.
    expect(args('mp4')).not.toContain('-vf')
    expect(line).toContain('-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart')
    expect(args('mp4').at(-1)).toBe('out.mp4')
  })

  it('HiDPI: escala a captura maior até o tamanho final do vídeo', () => {
    const filters = rawVideoFilters({
      width: 1920,
      height: 1080,
      captureWidth: 3840,
      captureHeight: 2160,
      format: 'mp4',
    })
    expect(filters).toEqual(['scale=1920:1080:flags=lanczos'])
    expect(args('mp4', { width: 3840, height: 2160 }).join(' ')).toContain('-vf scale=1920:1080:flags=lanczos')
  })

  it('alfa: o formato com alfa entra no filtro e o encoder pede o plano alfa', () => {
    expect(rawVideoFilters({ width: 100, height: 100, captureWidth: 100, captureHeight: 100, format: 'mov-alpha' })).toEqual([
      'format=yuva444p10le',
    ])
    expect(
      rawVideoFilters({ width: 100, height: 100, captureWidth: 100, captureHeight: 100, format: 'webm-alpha' }),
    ).toEqual(['format=yuva420p'])

    const mov = args('mov-alpha').join(' ')
    expect(mov).toContain('-vf format=yuva444p10le')
    expect(mov).toContain('-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le')

    const webm = args('webm-alpha').join(' ')
    expect(webm).toContain('-vf format=yuva420p')
    expect(webm).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 28 -row-mt 1')

    // A desmultiplicação NÃO é filtro: o `unpremultiply` deste ffmpeg tem duas
    // entradas e recusa o grafo simples. Ela acontece no buffer, antes disto.
    expect(mov).not.toContain('unpremultiply')
    expect(webm).not.toContain('unpremultiply')
  })

  it('HiDPI no modo transparente: escala antes da conversão de formato', () => {
    expect(
      rawVideoFilters({ width: 100, height: 50, captureWidth: 200, captureHeight: 100, format: 'mov-alpha' }),
    ).toEqual(['scale=100:50:flags=lanczos', 'format=yuva444p10le'])
  })

  it('sem alfa não há filtro nenhum (nem desmultiplicação)', () => {
    expect(rawVideoFilters({ width: 10, height: 10, captureWidth: 10, captureHeight: 10, format: 'mp4' })).toEqual([])
    expect(rawVideoFilters({ width: 10, height: 10, captureWidth: 10, captureHeight: 10, format: 'webm' })).toEqual([])
    expect(motionEncoderArgs('webm').join(' ')).toContain('libvpx-vp9 -pix_fmt yuv420p')
  })
})

describe('quadro cru', () => {
  it('um quadro BGRA tem largura × altura × 4 bytes', () => {
    expect(expectedFrameBytes(1920, 1080)).toBe(8_294_400)
    expect(expectedFrameBytes(3840, 2160)).toBe(33_177_600)
  })

  it('assertFrameBytes aceita o tamanho exato e falha alto em qualquer outro', () => {
    expect(() => assertFrameBytes(8_294_400, 1920, 1080, 0)).not.toThrow()
    // Um quadro a mais ou a menos desalinharia o stdin inteiro em silêncio.
    expect(() => assertFrameBytes(8_294_404, 1920, 1080, 3)).toThrow(/frame 3 came with 8294404 bytes, expected 1920x1080x4 = 8294400/)
    expect(() => assertFrameBytes(8_294_399, 1920, 1080, 7)).toThrow(/frame 7/)
  })
})

describe('desmultiplicação do alfa', () => {
  it('vira cor reta: (200,100,50) a 50% chega pré-multiplicado e sai reto', () => {
    // O Chromium entrega assim: cor reta (200,100,50) com alfa 128 => (100,50,25,128).
    const buffer = bgra([[25, 50, 100, 128]])
    unpremultiplyBgra(buffer)
    expect(pixel(buffer)).toEqual([50, 100, 199, 128])
  })

  it('não mexe em pixel opaco nem em pixel vazio', () => {
    const buffer = bgra([
      [10, 20, 30, 255],
      [0, 0, 0, 0],
      [200, 100, 50, 255],
    ])
    const before = Buffer.from(buffer)
    unpremultiplyBgra(buffer)
    expect(buffer.equals(before)).toBe(true)
  })

  it('desmultiplica pixel a pixel, sem contaminar os vizinhos', () => {
    const buffer = bgra([
      [25, 50, 100, 128],
      [200, 100, 50, 255],
      [0, 25, 50, 64],
    ])
    unpremultiplyBgra(buffer)
    expect(pixel(buffer, 0)).toEqual([50, 100, 199, 128])
    expect(pixel(buffer, 1)).toEqual([200, 100, 50, 255])
    // alfa 64 => fator 1020: 0, 25 e 50 viram 0, 100 e 199.
    expect(pixel(buffer, 2)).toEqual([0, 100, 199, 64])
  })

  it('prende em 255 em vez de estourar o byte (cor maior que o alfa)', () => {
    // Pré-multiplicado de verdade nunca tem cor > alfa, mas dado torto não pode
    // virar byte virado (255 daria 65025, que num Uint8Array viraria 0).
    const buffer = bgra([[255, 255, 255, 1]])
    unpremultiplyBgra(buffer)
    expect(pixel(buffer)).toEqual([255, 255, 255, 1])
  })

  it('não lê além do buffer quando o quadro tem tamanho ímpar de pixels', () => {
    const buffer = bgra([[25, 50, 100, 128], [25, 50, 100, 128]])
    expect(() => unpremultiplyBgra(buffer)).not.toThrow()
    expect(buffer.length).toBe(8)
  })
})

describe('faixas', () => {
  it('bandCount: núcleos/2 no automático, teto de 4, e o escape explícito manda', () => {
    expect(bandCount(undefined, 2)).toBe(1)
    expect(bandCount(undefined, 8)).toBe(4)
    expect(bandCount(undefined, 32)).toBe(MAX_MOTION_BANDS)
    // Um núcleo só (ou um `cores` esquisito) nunca zera o render.
    expect(bandCount(undefined, 1)).toBe(1)
    expect(bandCount(undefined, 0)).toBe(1)
    // Escape: 1 é o caminho sequencial; acima do teto é preso no teto.
    expect(bandCount(1, 8)).toBe(1)
    expect(bandCount(2, 8)).toBe(2)
    expect(bandCount(9, 8)).toBe(MAX_MOTION_BANDS)
    expect(bandCount(0, 8)).toBe(1)
  })

  it('splitBands cobre [0, total) sem buraco nem sobreposição', () => {
    expect(splitBands(10, 3)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 10 },
    ])
    expect(splitBands(5, 4)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 5 },
    ])
    // Menos quadros que faixas: nunca cria faixa vazia.
    expect(splitBands(3, 4)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
    // `bands: 1` é o caminho sequencial: uma faixa com o vídeo inteiro.
    expect(splitBands(300, 1)).toEqual([{ start: 0, end: 300 }])
    expect(splitBands(1, 4)).toEqual([{ start: 0, end: 1 }])
  })

  it('as faixas somam exatamente o total, em qualquer combinação', () => {
    for (let total = 1; total <= 40; total++) {
      for (let bands = 1; bands <= 6; bands++) {
        const ranges = splitBands(total, bands)
        expect(ranges[0].start).toBe(0)
        expect(ranges.at(-1)?.end).toBe(total)
        let expected = 0
        for (const [i, band] of ranges.entries()) {
          expect(band.start).toBe(expected)
          expect(band.end).toBeGreaterThan(band.start)
          expected = band.end
          if (i) expect(band.end - band.start).toBeLessThanOrEqual(ranges[0].end - ranges[0].start)
        }
      }
    }
  })
})

describe('concatenação das faixas', () => {
  it('concatList escreve um `file` por segmento, na ordem', () => {
    expect(concatList(['band_000.mp4', 'band_001.mp4'])).toBe("file 'band_000.mp4'\nfile 'band_001.mp4'")
  })

  it('concatFfmpegArgs copia os segmentos e devolve o faststart ao mp4', () => {
    const mp4 = concatFfmpegArgs({ listFile: 'list.txt', output: 'out.mp4', format: 'mp4' }).join(' ')
    expect(mp4).toContain('-f concat -safe 0 -i list.txt')
    expect(mp4).toContain('-c copy')
    expect(mp4).toContain('-movflags +faststart')
    expect(mp4.endsWith('out.mp4')).toBe(true)

    // Sem segunda perda em nenhum formato: o segmento já saiu no encoder final.
    const webm = concatFfmpegArgs({ listFile: 'list.txt', output: 'out.webm', format: 'webm-alpha' }).join(' ')
    expect(webm).toContain('-c copy')
    expect(webm).not.toContain('-c:v')
    expect(webm).not.toContain('movflags')
  })
})

describe('áudio da peça', () => {
  it('reconhece áudio pela extensão', () => {
    expect(isMotionAudioFile('audio.mp3')).toBe(true)
    expect(isMotionAudioFile('VOZ.WAV')).toBe(true)
    expect(isMotionAudioFile('trilha.m4a')).toBe(true)
    expect(isMotionAudioFile('trilha.flac')).toBe(true)
    expect(isMotionAudioFile('index.html')).toBe(false)
    expect(isMotionAudioFile('clipe.mp4')).toBe(false)
    expect(isMotionAudioFile('audio')).toBe(false)
  })

  it('o codec segue o contêiner, não o gosto', () => {
    expect(motionAudioCodec('mp4')).toEqual(['-c:a', 'aac', '-b:a', '192k'])
    expect(motionAudioCodec('mov-alpha')).toEqual(['-c:a', 'aac', '-b:a', '192k'])
    expect(motionAudioCodec('webm')).toEqual(['-c:a', 'libopus', '-b:a', '128k'])
    expect(motionAudioCodec('webm-alpha')).toEqual(['-c:a', 'libopus', '-b:a', '128k'])
  })

  it('o mux copia o vídeo, codifica só o som e trava o comprimento na peça', () => {
    const args = motionAudioFfmpegArgs({
      video: 'video.mp4',
      audio: 'voz.wav',
      output: 'out.mp4',
      duration: 5.5,
      format: 'mp4',
    }).join(' ')
    expect(args).toContain('-i video.mp4 -i voz.wav')
    expect(args).toContain('-map 0:v:0 -map 1:a:0')
    expect(args).toContain('-c:v copy')
    expect(args).toContain('-c:a aac')
    expect(args).toContain('-t 5.500')
    expect(args).toContain('-movflags +faststart')
    expect(args.endsWith('out.mp4')).toBe(true)
  })

  it('nunca usa -shortest: áudio curto não pode encurtar o vídeo', () => {
    const webm = motionAudioFfmpegArgs({
      video: 'video.webm',
      audio: 'voz.mp3',
      output: 'out.webm',
      duration: 3,
      format: 'webm-alpha',
    }).join(' ')
    expect(webm).not.toContain('-shortest')
    expect(webm).toContain('-c:a libopus')
    expect(webm).not.toContain('movflags')
  })

  /** O grafo de filtros dos argumentos (a string logo depois de -filter_complex). */
  type MixEvents = Parameters<typeof motionAudioMixFfmpegArgs>[0]['events']
  const graphOf = (events: MixEvents, duration = 8): string => {
    const args = motionAudioMixFfmpegArgs({ video: 'video.mp4', output: 'out.mp4', duration, format: 'mp4', events })
    return args[args.indexOf('-filter_complex') + 1] ?? ''
  }

  it('o caso simples não paga o grafo de filtros', () => {
    expect(isPlainAudioEvent({ file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false })).toBe(true)
    expect(isPlainAudioEvent({ file: 'a.wav', start: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false })).toBe(false)
    expect(isPlainAudioEvent({ file: 'a.wav', start: 0, gainDb: -6, fadeIn: 0, fadeOut: 0, duck: false })).toBe(false)
    expect(isPlainAudioEvent({ file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: true })).toBe(false)
  })

  it('cada faixa entra no instante dela, com nível e rampas', () => {
    const graph = graphOf([
      { file: 'voz.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'cama.wav', start: 1.5, gainDb: -18, fadeIn: 0.5, fadeOut: 1, duck: true },
    ])
    // `all=1` cobre mono e estéreo: sem ele um arquivo mono sairia mudo.
    expect(graph).toContain('adelay=1500:all=1')
    expect(graph).toContain('volume=-18.00dB')
    expect(graph).toContain('afade=in:st=0:d=0.500')
    // A rampa de saída começa no fim da PEÇA (8s), não no fim do arquivo: o
    // comprimento é o da composição.
    expect(graph).toContain('afade=out:st=5.500:d=1.000')
    expect(graph).toContain('[1:a]')
  })

  it('o amix NUNCA normaliza: a narração não pode baixar porque existe música', () => {
    const graph = graphOf([
      { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'b.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
    ])
    expect(graph).toContain('amix=inputs=2:normalize=0')
    // O `duration=first` do render de EDL cortaria o mix na PRIMEIRA faixa: aqui
    // ela pode ser um efeito de meio segundo, e não pode mandar no resto.
    expect(graph).not.toContain('duration=first')
  })

  it('a cama abaixa sob a soma das faixas de frente (o mesmo duck do EDL)', () => {
    const graph = graphOf([
      { file: 'voz.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'efeito.wav', start: 3, gainDb: -6, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'cama.wav', start: 0, gainDb: -18, fadeIn: 0, fadeOut: 0, duck: true },
    ])
    // A frente é somada e PARTIDA: uma cópia vai para o mix, outra aciona o duck.
    expect(graph).toContain('[t0][t1]amix=inputs=2:normalize=0:dropout_transition=0[front]')
    expect(graph).toContain('[front]asplit=2[frontmix][frontsc]')
    expect(graph).toContain('sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350')
    expect(graph).toContain('[bedducked][frontmix]amix=inputs=2:normalize=0:dropout_transition=0[mix]')
  })

  it('sem cama não há duck, e uma faixa só não passa por amix nenhum', () => {
    const sum = graphOf([
      { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'b.wav', start: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
    ])
    expect(sum).toContain('amix=inputs=2')
    expect(sum).not.toContain('sidechaincompress')

    const single = motionAudioMixFfmpegArgs({
      video: 'v.mp4',
      output: 'o.mp4',
      duration: 5,
      format: 'mp4',
      events: [{ file: 'voz.wav', start: 1, gainDb: -3, fadeIn: 0, fadeOut: 0, duck: false }],
    }).join(' ')
    expect(single).toContain('-map [t0]')
    expect(single).not.toContain('amix')
  })

  it('o tratamento da faixa entra antes do nível, e a curva de volume depois do atraso', () => {
    const graph = graphOf([
      {
        file: 'voz.wav',
        start: 2,
        gainDb: -3,
        fadeIn: 0,
        fadeOut: 0,
        duck: false,
        fx: {
          highpass: 80,
          eq: [{ freq: 3500, gain: 2, q: 1 }],
          compress: { threshold: -20, ratio: 3, attack: 8, release: 200, makeup: 0 },
          automation: [
            { at: 0, db: -20 },
            { at: 4, db: 0 },
          ],
        },
      },
    ])
    const chain = graph.split(';')[0]
    const order = ['highpass=f=80', 'equalizer=', 'acompressor=', 'volume=-3.00dB', 'adelay=2000:all=1', "volume='pow(10"]
    const at = order.map((piece) => chain.indexOf(piece))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('uma faixa com tratamento já não é o caso simples', () => {
    const plain = { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    expect(isPlainAudioEvent({ ...plain, fx: { eq: [], automation: [] } })).toBe(true)
    expect(isPlainAudioEvent({ ...plain, fx: { highpass: 80, eq: [], automation: [] } })).toBe(false)
  })

  it('o acabamento torna até a faixa única um mix, e a saída dele é a do grafo', () => {
    const plain = { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    expect(isPlainAudioMix([plain])).toBe(true)
    expect(isPlainAudioMix([plain], { limit: -1 })).toBe(false)
    expect(isPlainAudioMix([plain, plain])).toBe(false)

    const args = motionAudioMixFfmpegArgs({
      video: 'v.mp4',
      output: 'o.mp4',
      duration: 5,
      format: 'mp4',
      events: [plain],
      master: { loudness: -16, limit: -1 },
    })
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('[t0]loudnorm=I=-16:TP=-1:LRA=11,aresample=48000,alimiter=limit=0.8913:level=0[master]')
    expect(args.join(' ')).toContain('-map [master]')
  })

  it('o duck personalizado vem da primeira cama que o declarou', () => {
    const graph = graphOf([
      { file: 'voz.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      {
        file: 'cama.wav',
        start: 0,
        gainDb: -18,
        fadeIn: 0,
        fadeOut: 0,
        duck: true,
        duckSettings: { threshold: 0.01, ratio: 6, attack: 50, release: 800 },
      },
    ])
    expect(graph).toContain('sidechaincompress=threshold=0.01:ratio=6:attack=50:release=800')
    expect(graph).not.toContain('attack=15')
  })
})
