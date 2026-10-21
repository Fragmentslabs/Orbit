/**
 * Registry de ativos produzidos pelo agente: toda imagem (show_image,
 * screenshots, scripts de browser), toda imagem colada pelo usuário e todo
 * artefato HTML (create_artifact) ganham um registro em
 * orbit-data/media/index.json. A galeria do painel direito lê daqui.
 *
 * O índice é único, mas o BYTE mora onde faz sentido: imagens em
 * orbit-data/media, artefatos em orbit-data/artifacts. Nada é duplicado — o
 * registro é um ponteiro (`path` é absoluto) e `kind` diz como abrir.
 */

export type MediaSource = "chat" | "user" | "screenshot" | "script" | "batch"

/**
 * De onde veio uma imagem buscada na web e sob que licença — o que a licença
 * costuma exigir que apareça junto quando ela é usada (CC BY, CC BY-SA). Fica no
 * item de mídia para o crédito acompanhar a imagem até a peça.
 */
export interface MediaCredit {
  title?: string
  creator?: string
  /** "CC BY-SA 4.0", "CC0 1.0", "Public domain"… */
  license: string
  licenseUrl?: string
  /** Página de origem da imagem (onde o autor e a licença se confirmam). */
  sourceUrl: string
  provider: "commons" | "openverse"
  /** A linha de crédito pronta, para pôr numa legenda ou na tela final. */
  attribution: string
}

/**
 * Imagem (o caso histórico), artefato HTML renderizável, documento
 * (relatório/proposta autorado pelo agente, entregue em PDF e/ou DOCX), áudio
 * (anexado pelo usuário ou gerado pelo agente) ou motion (uma peça: a
 * composição é uma PASTA do projeto e nada dela é copiado para cá — o registro
 * guarda a capa e o `motionId`, e abrir é reabrir a aba Motion) ou video (um
 * vídeo anexado pelo usuário, ou produzido no chat: o arquivo mora no app, o
 * registro guarda a capa e a URL de reprodução).
 * Ausente em registros gravados antes disso existir = "image".
 */
export type MediaKind = "image" | "artifact" | "document" | "audio" | "motion" | "video" | "design"

/** Formatos de entrega de um documento. O fonte é sempre Markdown; estes são
 *  os arquivos renderizados a partir dele. */
export type DocumentFormat = "pdf" | "docx"

/**
 * O que dá para BAIXAR de um documento. O `.md` é o próprio fonte, copiado
 * como está; PDF e DOCX são renderizados na hora quando ainda não existem em
 * disco.
 *
 * O documento NASCE só em Markdown: renderizar na criação custava uma janela
 * do Chromium por documento, e a maioria nunca vira arquivo — o usuário lê no
 * chat e segue. Por isso esta lista é FIXA, e não o `formats` do registro, que
 * diz apenas o que já está em cache.
 */
export type DocumentDownload = DocumentFormat | "md"

export const DOCUMENT_DOWNLOADS: DocumentDownload[] = ["md", "pdf", "docx"]

export interface MediaEntry {
  /** Nome do arquivo (também é a URL: orbit-media://<id> ou orbit-artifact://<id>) */
  id: string
  /** URL pronta para exibir. No desktop vem de `assetUrl`; no companion o
   *  servidor preenche com http://host/api/media/<id>?t=<token assinado>. */
  url?: string
  /** Caminho absoluto no disco — a fonte da verdade para ler/apagar o arquivo,
   *  já que imagens e artefatos vivem em diretórios diferentes. */
  path: string
  size: number
  createdAt: number
  source: MediaSource
  kind?: MediaKind
  /** Chat que originou o ativo (quando veio de uma tool) */
  sessionId?: string
  /**
   * Outras sessões em que este ativo também deve aparecer em "Neste chat" —
   * hoje, só forks. `forkSession` clona as mensagens com novos ids de part,
   * mas aponta para o MESMO documentId/mediaUrl (nada é duplicado); sem isto,
   * o card continua visível na conversa do fork, mas some do filtro "Neste
   * chat" porque `sessionId` aqui é fixo na sessão original.
   *
   * `directory`/`folderId` continuam derivados de `sessionId` (a sessão de
   * origem) — um fork herda o mesmo projeto na criação, então não há porque
   * esses dois escopos também precisarem de uma lista.
   */
  linkedSessionIds?: string[]
  /** Mensagem do assistente onde o ativo aparece */
  messageId?: string
  /** Tarefa de run_browser_script/capture_batch que gerou a imagem */
  taskId?: string
  /**
   * Imagem da qual esta foi derivada (image_edit sobre um item da galeria).
   *
   * É o que transforma cinco arquivos soltos numa cadeia: a galeria colapsa a
   * descendência num tile só, e o runtime sabe quais passos foram apenas
   * degraus para o resultado. A origem continua sendo lida de `source`:
   * 'user' é anexo do usuário (intocável), qualquer outra é do agente.
   */
  parentId?: string
  /** Rótulo dado pelo script (capture('home')), legenda do show_image ou
   *  título do artefato */
  name?: string
  width?: number
  height?: number
  /** Só em artefatos: id do PNG de miniatura (mesma pasta do .html), capturado
   *  na criação para a galeria continuar sendo um grid de imagens. Ausente
   *  quando a captura falhou — o tile cai no ícone. */
  thumb?: string
  /**
   * Só em documentos VIVOS em Markdown: a mesma capa no tema escuro.
   *
   * São duas porque a capa é a tela nativa, e o tema muda depois da captura.
   * Quem foi pedido como arquivo não tem: a folha branca é a cara dele nos
   * dois temas, porque é assim que ele vai sair impresso.
   */
  thumbDark?: string
  /** Só em artefatos: incrementa a cada update_artifact. O arquivo é reescrito
   *  no lugar (a URL não muda), então é isto que invalida o cache do iframe. */
  revision?: number
  /** Só em imagens buscadas na web: autor e licença (ver MediaCredit). */
  credit?: MediaCredit
  /**
   * Só em peças de motion: o id da composição no registro do main
   * (`orbit-data/motion.json`). É por ele que a aba Motion reabre a peça — e o
   * ÚNICO vínculo com o conteúdo, já que a composição mora na pasta do projeto
   * e nada dela é copiado para a galeria.
   */
  motionId?: string
  /**
   * Só em canvas de design: o id do canvas no registro do main
   * (`orbit-data/design.json`). Espelha `motionId` — a pasta mora no
   * armazenamento do app (modo chat) e nada dela é copiado para a galeria além
   * da capa; abrir é reabrir a aba Design.
   */
  designId?: string
  /**
   * Material da aba Fontes: a pasta da sidebar com que este arquivo é
   * COMPARTILHADO. Ausente = é só da conversa (`sessionId`). É o equivalente, para
   * foto, GIF, áudio e vídeo, do escopo `srcN` dos documentos.
   */
  sharedFolderId?: string
  /** Só em vídeos: a URL orbit-video:// que o visor da galeria toca. */
  videoUrl?: string
  /** Só em vídeos: duração em ms (a etiqueta do tile). */
  durationMs?: number
  /** Só em documentos: quais renderizações existem em disco. Vazio é o caso
   *  normal — o documento nasce só em Markdown e o arquivo é gerado no
   *  primeiro download. */
  formats?: DocumentFormat[]
  /**
   * Só em documentos: os formatos que foram PEDIDOS de propósito — o usuário
   * disse "faz um PDF", "me manda em Word". Ausente é o caso normal: um
   * documento vivo em Markdown, que se lê e se edita na conversa.
   *
   * Separado de `formats` porque os dois respondem perguntas diferentes:
   * `formats` é cache e cresce sozinho quando alguém baixa o arquivo, e
   * baixar uma cópia não pode transformar o documento num entregável.
   */
  delivery?: DocumentFormat[]
  /**
   * Só em documentos: a fonte da conversa (`doc3`, `src1`) que este documento
   * virou quando o usuário o promoveu. É o que torna promover idempotente —
   * clicar de novo foca o que já existe em vez de criar uma cópia.
   *
   * Pode apontar para uma fonte já removida: o id é conferido contra a lista
   * antes de valer, e promover de novo repõe o que foi apagado.
   */
  sourceId?: string
  /**
   * Só em documentos: há edição do USUÁRIO que o agente ainda não viu.
   *
   * Marcada quando o canvas grava, limpa quando o agente escreve por cima
   * sabendo da versão nova. É o que impede uma reescrita cega de apagar o que
   * a pessoa acabou de digitar.
   */
  userEdited?: boolean
  /**
   * Só em documentos: o arquivo veio de FORA e não tem fonte em Markdown — a
   * cópia editada de um .docx anexado, o resultado de juntar ou recortar PDFs.
   * O `.md` do registro é só um bilhete dizendo onde está o conteúdo real.
   *
   * É o que impede converter esses documentos sob demanda: o que seria
   * renderizado é o preview, não o documento.
   */
  derived?: boolean
  /**
   * Só em documentos: a personalização escolhida (fonte, tamanho, cor de
   * destaque, margem, colunas, alinhamento). Guardada aqui para o
   * update_document manter o visual sem o agente ter que repetir o estilo a
   * cada alteração de texto.
   */
  style?: Record<string, unknown>
  /**
   * Projeto a que o ativo pertence — a pasta de trabalho da sessão que o
   * criou, capturada NO MOMENTO da criação.
   *
   * A galeria já derivava isso da sessão, mas derivar não basta para duas
   * coisas: o vínculo morre quando a sessão é excluída, e o AGENTE não tem
   * como achar o que produziu antes no mesmo repositório. Gravado aqui, o
   * documento continua encontrável pelo projeto mesmo sem a conversa.
   */
  directory?: string
  /** Pasta da sidebar em que a sessão estava (modo chat, onde não há
   *  diretório) — o equivalente de `directory` para o agrupamento manual. */
  folderId?: string
}

export interface MediaFilter {
  source?: MediaSource | MediaSource[]
  kind?: MediaKind | MediaKind[]
  sessionId?: string
  /** Escopo por projeto: todos os ativos daquela pasta de trabalho,
   *  independentemente da sessão que os criou. */
  directory?: string
  folderId?: string
  /** createdAt >= since */
  since?: number
  /** Busca (case-insensitive) em name/taskId/id */
  query?: string
}

export interface MediaUsage {
  count: number
  bytes: number
}

export const MEDIA_SCHEME = "orbit-media"
export const ARTIFACT_SCHEME = "orbit-artifact"
/** Áudios (anexados e gerados): scheme próprio, com o privilégio `stream` que o <audio> exige. */
export const AUDIO_SCHEME = "orbit-audio"
/**
 * Vídeos que o agente renderizou (edição de vídeo): servidos direto do arquivo
 * do projeto, com Range — um vídeo não é copiado para a pasta do app.
 */
export const VIDEO_SCHEME = "orbit-video"
/**
 * Composições de motion (pasta do projeto: entrada HTML + dependências que o
 * preview serve, com `corsEnabled` — fontes e `<script type="module">` numa
 * origem opaca exigem CORS). Diferente dos vídeos, aqui se serve uma PASTA.
 */
export const MOTION_SCHEME = "orbit-motion"
/**
 * Canvas de design (pasta do app: canvas.json + um .html por artboard, servidos
 * estáticos — sem runtime injetado, já que não há linha do tempo nem seek). Mesmo
 * `corsEnabled` do motion: fonte @font-face e fetch dentro do artboard exigem CORS.
 */
export const DESIGN_SCHEME = "orbit-design"
/**
 * Fontes baixadas pelo Orbit (biblioteca em `orbit-data/fonts`). Servidas por
 * arquivo com hash no nome, `corsEnabled` e `Access-Control-Allow-Origin: *`:
 * o artboard, a composição de motion e a própria janela do app (outra origem)
 * declaram a mesma fonte por `@font-face`.
 */
export const FONT_SCHEME = "orbit-font"

/**
 * MIME do drag & drop interno: o tile da aba Mídia arrasta o item COMO ANEXO
 * para o composer. O payload leva só a IDENTIDADE do item (id, nome, tipo e uma
 * URL de preview) — nunca os bytes: o anexo é uma REFERÊNCIA ao arquivo que já
 * existe na galeria, então nada é copiado nem colado como texto no input. Sem
 * isso o drag nativo do <img> só levava o texto da URL e o drop colava o
 * caminho no campo.
 */
export const MEDIA_DND_MIME = "application/x-orbit-media"

/** `kind` normalizado — registros antigos não têm o campo. */
export function mediaKind(entry: Pick<MediaEntry, "kind">): MediaKind {
  return entry.kind ?? "image"
}

/**
 * MIME de uma entrada da galeria. O registro não guarda MIME (o id é a fonte da
 * verdade) — ele sai da extensão do id e, se ela não for reconhecida, do `kind`.
 * É o que o composer usa para decidir se mostra o thumbnail no chip.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  weba: "audio/webm",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

const KIND_FALLBACK_MIME: Record<MediaKind, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  artifact: "text/html",
  document: "text/markdown",
  motion: "text/html",
  design: "text/html",
}

export function mediaMime(entry: Pick<MediaEntry, "id" | "kind">): string {
  const ext = entry.id.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? KIND_FALLBACK_MIME[mediaKind(entry)]
}

/**
 * Id de um vídeo anexado (`vdo_…`): o nome do arquivo na pasta de anexos de
 * vídeo do app. Fica aqui, e não no main, porque media.ts (que apaga o arquivo) e
 * attachment-ref.ts (que o guarda) precisam do MESMO formato e um importa o outro.
 */
export const SAFE_VIDEO_MEDIA_ID = /^vdo_[a-z0-9]+\.(mp4|m4v|mov|webm|mkv|avi)$/

/**
 * URL que ABRE o ativo: a imagem em si, o HTML do artefato, ou — no
 * documento — o HTML de preview, porque o Electron não tem visualizador de
 * PDF e o .docx não é renderizável no navegador. PDF e DOCX são entrega
 * (abrir fora, exportar), não visualização embutida.
 */
export function assetUrl(entry: Pick<MediaEntry, "id" | "kind" | "thumb" | "thumbDark" | "revision" | "videoUrl">): string {
  const kind = mediaKind(entry)
  if (kind === "artifact") return `${ARTIFACT_SCHEME}://${entry.id}`
  if (kind === "document") return `${ARTIFACT_SCHEME}://${documentPreviewId(entry.id)}`
  if (kind === "audio") return `${AUDIO_SCHEME}://${entry.id}`
  // A peça não tem arquivo próprio para abrir: o único byte guardado na galeria
  // é a CAPA (a composição é uma pasta do projeto, servida pelo
  // orbit-motion:// e reaberta pela aba). Sem esta linha o id da capa seria
  // pedido ao scheme errado e voltaria vazio.
  if (kind === "motion") return thumbUrl(entry) ?? `${MEDIA_SCHEME}://${entry.id}`
  // Mesmo caso do motion: o canvas mora na pasta do app, não na galeria — o
  // único byte guardado aqui é a capa.
  if (kind === "design") return thumbUrl(entry) ?? `${MEDIA_SCHEME}://${entry.id}`
  // O vídeo toca pela URL do player; sem ela (registro sem player) cai na capa.
  if (kind === "video") return entry.videoUrl ?? thumbUrl(entry) ?? `${MEDIA_SCHEME}://${entry.id}`
  return `${MEDIA_SCHEME}://${entry.id}`
}

/** O id do documento é o do FONTE (doc_x.md); o preview é o irmão .html. */
export function documentPreviewId(id: string): string {
  return id.replace(/\.md$/, '.html')
}

/**
 * URL da MINIATURA para o grid — null quando o artefato não tem captura e o
 * tile precisa cair no ícone.
 *
 * A miniatura do artefato é reescrita com o MESMO nome a cada
 * update_artifact, então a revisão entra na query: sem ela o grid continuaria
 * exibindo a captura da versão anterior.
 */
export function thumbUrl(
  entry: Pick<MediaEntry, "id" | "kind" | "thumb" | "thumbDark" | "revision">,
  dark = false,
): string | null {
  if (mediaKind(entry) === "image") return `${MEDIA_SCHEME}://${entry.id}`
  // Áudio não tem capa: o tile mostra o ícone (e toca no clique).
  if (mediaKind(entry) === "audio") return null
  // Só o documento vivo tem capa escura; o resto cai na clara, que é a única.
  const thumb = (dark && entry.thumbDark) || entry.thumb
  return thumb ? `${ARTIFACT_SCHEME}://${thumb}?rev=${entry.revision ?? 1}` : null
}

/**
 * Onde o documento abre no painel lateral.
 *
 * Pedido como arquivo (ou vindo de fora), abre no VISUALIZADOR de documento —
 * o mesmo painel do PDF anexado, com sumário, localizar, zoom e imprimir, que
 * é o que se quer de um arquivo pronto. Documento vivo em Markdown abre no
 * canvas, onde dá para ler e editar.
 */
export function documentOpensAsFile(
  doc: Pick<MediaEntry, "delivery" | "derived">,
): boolean {
  return doc.derived === true || (doc.delivery?.length ?? 0) > 0
}

/** Nome de arquivo seguro a partir do título, para exportar/salvar. */
export function documentFileName(title: string, format: DocumentDownload): string {
  const base = title.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 60) || "documento"
  return `${base}.${format}`
}

/**
 * Um MATERIAL da aba Fontes — foto, GIF, áudio ou vídeo que a conversa tem à mão.
 * É a visão de um item de mídia: o arquivo mora na galeria (e some de lá se for
 * excluído de lá), e a aba só o lista no escopo certo.
 */
export interface MaterialView {
  /** A referência que o agente usa: `img_…`, `aud_…` ou `vdo_…`. */
  id: string
  kind: "image" | "audio" | "video"
  name: string
  sizeBytes: number
  createdAt: number
  durationMs?: number
  width?: number
  height?: number
  /** Capa para a lista; null quando não há (áudio). */
  thumbUrl: string | null
  /** O que o visor da aba toca ou mostra. */
  playUrl: string | null
  /** Está no escopo da pasta (compartilhado com as outras conversas dela). */
  shared: boolean
  animated: boolean
}
