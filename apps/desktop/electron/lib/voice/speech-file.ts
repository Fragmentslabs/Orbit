/**
 * Leitura em voz alta SOB DEMANDA, entregue como ARQUIVO — o caminho do app
 * companion.
 *
 * O desktop fala em streaming (`voice:tts:chunk` + `ChunkPlayer` no renderer):
 * PCM16 cru agendado num AudioContext. O celular não tem AudioContext nem um
 * caminho barato para tocar PCM ao vivo, então a fala atravessa de outro jeito:
 * o texto vai em `POST /api/voice/speak`, o desktop sintetiza, escreve um WAV e
 * devolve a URL assinada do escopo `audio` — a MESMA rota que o player do
 * celular já usa para os áudios do agente (com Range, então dá para buscar
 * posição).
 *
 * O WAV mora na pasta de áudio, mas NÃO entra no índice de mídia de propósito:
 * ouvir a mesma resposta dez vezes encheria a galeria com dez entradas iguais.
 * Como `resolveAudioFile` valida só a FORMA do id (o arquivo existir basta), um
 * id fora do índice é servível do mesmo jeito.
 *
 * CACHE: o id é o hash de (texto, voz, idioma, velocidade), então ouvir de novo
 * a mesma resposta não sintetiza nada — o segundo toque é instantâneo. O
 * manifesto ao lado do cache guarda a duração (evita reabrir o WAV) e serve de
 * lista para a poda: sem ela, cada resposta ouvida deixaria um arquivo para
 * sempre.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { audioDir, audioFilePath } from '../audio-store'
import { synthesizeToWav } from './index'

/** Muda quando o áudio gravado muda de formato — invalida o cache inteiro. */
const CACHE_VERSION = 'v1'

/** Quantos WAV de fala ficam guardados; acima disso o mais antigo sai. */
export const MAX_SPEECH_CACHE_FILES = 200

const MANIFEST = 'speech-cache.json'

export interface SpokenFile {
  /** Id no acervo de áudio (`aud_….wav`) — serve o WAV pelo escopo `audio`. */
  id: string
  /** Duração do áudio, em milissegundos. */
  durationMs: number
  /** Já estava sintetizado: a resposta veio do cache. */
  cached: boolean
}

export interface SpeakFileOptions {
  voice?: string
  /** Idioma (`pt`, `en`, …) ou `auto`; ausente = o das preferências. */
  lang?: string
  speed?: number
}

/** O que o manifesto guarda por arquivo — e é o que sobra para podar. */
type Manifest = Record<string, { durationMs: number; usedAt: number }>

function manifestPath(): string {
  return path.join(audioDir(), MANIFEST)
}

async function readManifest(): Promise<Manifest> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Manifest
  } catch {
    // Sem manifesto (primeira vez, arquivo corrompido): o cache recomeça. Pior
    // caso é sintetizar de novo — nunca servir um arquivo que não existe.
    return {}
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await fs.mkdir(audioDir(), { recursive: true })
  const alvo = manifestPath()
  // Temporário + rename: uma leitura concorrente vê o manifesto antigo inteiro,
  // nunca um JSON pela metade.
  const tmp = `${alvo}.${process.pid}.part`
  await fs.writeFile(tmp, JSON.stringify(manifest))
  await fs.rename(tmp, alvo)
}

/**
 * Id do WAV de cache: `aud_<24 hex>.wav` — a mesma forma que `SAFE_AUDIO_ID`
 * exige (é o que torna o arquivo servível), sem carimbo de tempo, porque aqui o
 * conteúdo É a chave.
 */
export function speechCacheId(text: string, opts: SpeakFileOptions = {}): string {
  const hash = createHash('sha256')
    .update(
      [CACHE_VERSION, opts.voice ?? '', opts.lang ?? '', String(opts.speed ?? ''), text].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 24)
  return `aud_${hash}.wav`
}

/**
 * Sintetiza (ou reaproveita) o WAV da fala. Devolve o id e a duração; quem
 * chama monta a URL assinada, que depende do host da requisição.
 */
export async function speakToFile(text: string, opts: SpeakFileOptions = {}): Promise<SpokenFile> {
  const alvo = String(text ?? '').trim()
  if (!alvo) throw new Error('nada para falar: o texto está vazio')

  const id = speechCacheId(alvo, opts)
  const manifesto = await readManifest()
  const guardado = manifesto[id]
  if (guardado) {
    try {
      await fs.access(audioFilePath(id))
      manifesto[id] = { durationMs: guardado.durationMs, usedAt: Date.now() }
      await writeManifest(manifesto)
      return { id, durationMs: guardado.durationMs, cached: true }
    } catch {
      // O manifesto jurava que existia e não existe (pasta limpa por fora):
      // sintetiza de novo, como se nunca tivesse estado lá.
      delete manifesto[id]
    }
  }

  const { wav, durationMs } = await synthesizeToWav(alvo, opts)
  await fs.mkdir(audioDir(), { recursive: true })
  const arquivo = audioFilePath(id)
  const tmp = `${arquivo}.${process.pid}.part`
  await fs.writeFile(tmp, wav)
  // Rename é atômico: dois "ouvir" no mesmo texto não fazem o player abrir um
  // WAV pela metade.
  await fs.rename(tmp, arquivo)

  manifesto[id] = { durationMs, usedAt: Date.now() }
  await prune(manifesto)
  return { id, durationMs, cached: false }
}

/** Grava o manifesto e, se passou do teto, apaga os WAVs mais antigos. */
async function prune(manifesto: Manifest): Promise<void> {
  const ids = Object.keys(manifesto)
  if (ids.length > MAX_SPEECH_CACHE_FILES) {
    ids.sort((a, b) => manifesto[a].usedAt - manifesto[b].usedAt)
    for (const id of ids.slice(0, ids.length - MAX_SPEECH_CACHE_FILES)) {
      delete manifesto[id]
      await fs.rm(audioFilePath(id), { force: true }).catch(() => {
        // Já não estava lá — o manifesto é que estava desatualizado.
      })
    }
  }
  await writeManifest(manifesto)
}
