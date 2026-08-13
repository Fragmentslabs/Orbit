import { useMemo } from "react"
import { Image } from "@/src/components/ai/image"

/**
 * URLs orbit-media:// num texto (ex.: o manifest de screenshots que o agente
 * cola na descrição da task). Mesmo formato de id do protocolo no main
 * (media.ts: SAFE_ID) — nada de path traversal: só arquivos de imagem.
 */
const MEDIA_URL_RE = /orbit-media:\/\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)/g

export function extrairMediaUrls(texto: string): string[] {
  return Array.from(new Set(texto.match(MEDIA_URL_RE) ?? []))
}

/**
 * Grade das imagens orbit-media:// presentes num texto. A descrição da task
 * guarda as URLs como texto (é o que as fases recebem); aqui elas aparecem de
 * fato, com lightbox no clique, igual às imagens do chat.
 */
export function MediaEmbed({ texto }: { texto: string }) {
  const urls = useMemo(() => extrairMediaUrls(texto), [texto])
  if (urls.length === 0) return null
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {urls.map((url) => (
        <Image key={url} src={url} className="!my-0" />
      ))}
    </div>
  )
}
