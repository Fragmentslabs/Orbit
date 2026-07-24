import mammoth from 'mammoth'

const DATA_URL_PREFIX = /^data:[^;,]*;base64,/

function dataUrlToBuffer(url: string): Buffer {
  const match = DATA_URL_PREFIX.exec(url)
  if (!match) throw new Error('Formato de data URL inválido para DOCX')
  return Buffer.from(url.slice(match[0].length), 'base64')
}

const MAX_CHARS = 30000

/** Extrai o texto de um .docx anexado (mammoth lê o document.xml do zip). */
export async function extractDocxText(dataUrl: string): Promise<string> {
  const buffer = dataUrlToBuffer(dataUrl)
  const result = await mammoth.extractRawText({ buffer })
  const text = result.value.trim()
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n_(texto truncado — documento muito grande)_` : text
}
