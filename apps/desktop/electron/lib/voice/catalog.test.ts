import { describe, expect, it } from 'vitest'

import {
  fileNameOf,
  getSttModel,
  modelsForEngine,
  PARAKEET_DIR,
  SILERO_VAD_BYTES,
  STT_MODEL_DEFS,
} from './catalog'

/**
 * O catálogo não é decoração: o downloader do núcleo deriva o NOME do arquivo
 * do último segmento da URL e só considera o modelo instalado quando o tamanho
 * bate EXATO. Um id repetido, uma URL sem extensão ou um `bytes` arredondado
 * quebram o download de um jeito silencioso (baixa e nunca fica "instalado").
 * Estes testes fecham esses invariantes.
 */

describe('STT_MODEL_DEFS', () => {
  it('tem os modelos combinados: whisper tiny/base/small/medium/large-v3-turbo + parakeet', () => {
    expect(STT_MODEL_DEFS.map((m) => m.id)).toEqual([
      'whisper-tiny',
      'whisper-base',
      'whisper-small',
      'whisper-medium',
      'whisper-large-v3-turbo',
      'parakeet-tdt-0.6b-v3',
    ])
  })

  it('ids são únicos e não vazios', () => {
    const ids = STT_MODEL_DEFS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })

  it('a URL termina num nome de arquivo com extensão (o downloader usa esse nome)', () => {
    for (const def of STT_MODEL_DEFS) {
      const name = fileNameOf(def)
      expect(name).toMatch(/\.(bin|tar\.bz2)$/)
      expect(def.url.endsWith(name)).toBe(true)
    }
  })

  it('bytes é um número positivo (o tamanho exato do arquivo na origem)', () => {
    for (const def of STT_MODEL_DEFS) {
      expect(Number.isInteger(def.bytes)).toBe(true)
      expect(def.bytes).toBeGreaterThan(0)
    }
  })

  it('todo modelo declara idiomas, com pt entre eles', () => {
    for (const def of STT_MODEL_DEFS) {
      expect(def.langs.length).toBeGreaterThan(0)
      expect(def.langs).toContain('pt')
    }
  })

  it('classifica cada modelo num motor conhecido', () => {
    for (const def of STT_MODEL_DEFS) {
      expect(['whisper', 'parakeet']).toContain(def.engine)
    }
    expect(modelsForEngine('whisper')).toHaveLength(5)
    expect(modelsForEngine('parakeet')).toHaveLength(1)
  })

  it('o Parakeet é o único pacote (o resto é arquivo único do whisper.cpp)', () => {
    const arquivos = STT_MODEL_DEFS.filter((m) => m.archive)
    expect(arquivos.map((m) => m.id)).toEqual(['parakeet-tdt-0.6b-v3'])
    expect(arquivos[0].url).toContain(PARAKEET_DIR)
  })

  it('os modelos de whisper vêm do ggerganov/whisper.cpp e citam sha256', () => {
    for (const def of modelsForEngine('whisper')) {
      expect(def.url.startsWith('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/')).toBe(true)
      expect(def.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('getSttModel', () => {
  it('acha pelo id e devolve null para desconhecido/vazio', () => {
    expect(getSttModel('whisper-base')?.bytes).toBe(147951465)
    expect(getSttModel('nao-existe')).toBeNull()
    expect(getSttModel(null)).toBeNull()
    expect(getSttModel('')).toBeNull()
  })
})

describe('constantes do Parakeet', () => {
  it('o VAD Silero tem tamanho declarado (checado no disco)', () => {
    expect(SILERO_VAD_BYTES).toBe(643854)
  })
})
