import { cloneElement, useEffect, useRef, useState, type ReactElement } from "react"

import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"

type Side = "top" | "right" | "bottom" | "left"

/**
 * Mede um elemento de uma linha e diz se o texto está cortado.
 *
 * A decisão vem de scrollWidth/clientWidth e é reavaliada no resize — nunca
 * do tamanho da string, que depende da fonte e do idioma.
 */
function useTruncated(text?: string) {
  const ref = useRef<HTMLElement>(null)
  const [state, setState] = useState({ truncated: false, text: text ?? "" })

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const measure = () =>
      setState({
        truncated: element.scrollWidth > element.clientWidth + 1,
        // Sem `text` explícito, o rótulo é o próprio conteúdo do elemento —
        // que é o que o usuário não conseguiu ler.
        text: text ?? (element.textContent ?? "").trim(),
      })
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  return { ref, ...state }
}

interface TruncateProps {
  /** Opcional: sem ele, o rótulo é o `textContent` do elemento. */
  text?: string
  side?: Side
  /** O elemento que já corta — ele mesmo é medido, o layout não muda. */
  children: ReactElement<Record<string, unknown>>
}

/**
 * Envolve um elemento que JÁ corta (`truncate`) e só abre o tooltip quando o
 * texto está de fato cortado.
 *
 * É o caminho para o que já existe: nada é reescrito, só envolvido, e a medida
 * sai do próprio elemento. Exige que ele aceite `ref` — tag do DOM ou
 * componente que repassa (Badge, Button). Componente que não repassa degrada
 * em silêncio: nenhum ref, nenhum tooltip.
 */
function Truncate({ text, side = "top", children }: TruncateProps) {
  const { ref, truncated, text: label } = useTruncated(text)

  return (
    <Hint label={label} side={side} disabled={!truncated || !label} injectName={false}>
      {cloneElement(children, { ref } as Record<string, unknown>)}
    </Hint>
  )
}

interface TruncatedTextProps {
  text: string
  className?: string
  side?: Side
}

/**
 * Texto de uma linha que ganha tooltip **só quando está cortado**.
 *
 * Título de aba, nome de arquivo, nome de sessão: o `max-w` é o que mantém a
 * lista respirando, mas o pedaço que sobra na tela deixa de identificar o item.
 * Para um elemento que já existe e não pode ser trocado, use `Truncate`.
 */
function TruncatedText({ text, className, side = "top" }: TruncatedTextProps) {
  return (
    <Truncate      text={text} side={side}>
      <span className={cn("block min-w-0 truncate", className)}>{text}</span>
    </Truncate>
  )
}

export { Truncate, TruncatedText }
