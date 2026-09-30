import fsp from 'node:fs/promises'
import mammoth from 'mammoth'
import { sanitizeDocxHtml } from './docx-sanitize'
import { sessionDocumentFile } from './session-documents'

/**
 * Um .docx anexado, visto como documento.
 *
 * O painel sabia desenhar só PDF: o .docx era guardado, mas aberto ele virava
 * a lista de linhas do texto extraído — título, tabela e negrito achatados
 * numa coluna numerada, como se fosse código. O mammoth, que já está no
 * projeto para a prévia dos documentos do agente, converte o arquivo em HTML
 * com a estrutura dele: títulos, listas, tabelas, ênfase e as imagens
 * embutidas.
 *
 * O HTML vem de um arquivo de fora, então sai daqui limpo: só o que o mammoth
 * escreve, sem manipulador de evento, e com todo link apontando para fora do
 * app — um `javascript:` no hyperlink de um .docx não pode virar código
 * rodando no painel.
 */

/**
 * Um arquivo .docx em HTML limpo, venha de onde vier. As duas origens — o
 * anexo da conversa e o documento que o agente editou — passam por aqui, para
 * nenhuma delas ficar sem o saneamento.
 */
export async function docxFileToHtml(filePath: string): Promise<{ html: string } | null> {
  try {
    const buffer = await fsp.readFile(filePath)
    const { value } = await mammoth.convertToHtml({ buffer })
    return { html: sanitizeDocxHtml(value) }
  } catch {
    // Arquivo corrompido ou num formato que o mammoth não lê: o painel cai
    // para o modo Texto, que continua funcionando com o que foi extraído.
    return null
  }
}

export async function renderSessionDocx(
  sessionId: string,
  docId: string,
): Promise<{ html: string } | null> {
  const file = await sessionDocumentFile(sessionId, docId)
  if (!file || file.ext !== 'docx') return null
  try {
    return await docxFileToHtml(file.path)
  } catch {
    // Arquivo corrompido ou num formato que o mammoth não lê: o painel cai
    // para o modo Texto, que continua funcionando com o que foi extraído.
    return null
  }
}
