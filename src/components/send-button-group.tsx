import { useCallback, useState } from "react"
import { ListPlus, Send, Square } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { InputGroupButton } from "@/components/ui/input-group"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { ScheduleMessageDialog } from "@/src/components/schedule-message-dialog"

interface SendButtonGroupProps {
  busy: boolean
  onQueue: (text: string) => void
  onStopAndSend: (text: string) => void
  onSchedule: (text: string, timestamp: number) => void
  onSendToSidePanel: (text: string) => void
  onStop: () => void
  disabled?: boolean
}

export function SendButtonGroup({
  busy,
  onQueue,
  onStopAndSend,
  onSchedule,
  onSendToSidePanel,
  onStop,
  disabled,
}: SendButtonGroupProps) {
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const textInput = usePromptInputController().textInput
  const text = textInput.value.trim()
  const hasText = text.length > 0

  const withClear = useCallback(
    (fn: (text: string) => void) => {
      const current = textInput.value.trim()
      if (!current) return
      fn(current)
      textInput.clear()
    },
    [textInput],
  )

  const handleScheduleOpen = useCallback(() => {
    const current = textInput.value.trim()
    if (!current) return
    setPendingText(current)
    textInput.clear()
    setScheduleOpen(true)
  }, [textInput])

  const handleScheduleConfirm = useCallback(
    (timestamp: number) => {
      if (!pendingText) return
      onSchedule(pendingText, timestamp)
      setPendingText(null)
      setScheduleOpen(false)
    },
    [pendingText, onSchedule],
  )

  // Apenas botão de parar (sem texto, agente rodando)
  if (busy && !hasText) {
    return (
      <InputGroupButton
        aria-label="Parar"
        size="icon-sm"
        variant="default"
        type="button"
        onClick={onStop}
      >
        <Square className="size-4" />
      </InputGroupButton>
    )
  }

  // Agente rodando mas com texto no input: "Adicionar à fila" + dropdown
  if (busy && hasText) {
    return (
      <>
        <div className="flex items-center -space-x-px">
          <InputGroupButton
            aria-label="Adicionar à fila"
            size="sm"
            variant="default"
            type="button"
            className="rounded-r-none"
            onClick={() => withClear(onQueue)}
          >
            <ListPlus className="size-4 mr-1" />
            Adicionar à fila
          </InputGroupButton>
          <Select
            value=""
            onValueChange={(value) => {
              if (value === "side-panel") withClear(onSendToSidePanel)
              else if (value === "stop-send") withClear(onStopAndSend)
              else if (value === "schedule") handleScheduleOpen()
            }}
          >
            <SelectTrigger
              size="sm"
              className="rounded-l-none border-0 h-7 gap-0 px-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow"
              aria-label="Mais opções"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              side="top"
              sideOffset={4}
              align="end"
              alignItemWithTrigger={false}
              className="min-w-44 p-1"
            >
              <SelectItem value="side-panel">Abrir no chat lateral</SelectItem>
              <SelectItem value="stop-send">Parar e enviar</SelectItem>
              <SelectItem value="schedule">Agendar</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ScheduleMessageDialog
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          onConfirm={handleScheduleConfirm}
        />
      </>
    )
  }

  // Estado normal: botão "Enviar" (type=submit para o form) + dropdown
  return (
    <>
      <div className="flex items-center -space-x-px">
        <InputGroupButton
          aria-label="Enviar"
          size="sm"
          variant="default"
          type="submit"
          disabled={disabled || !text}
          className="rounded-r-none"
        >
          <Send className="size-4 mr-1" />
          Enviar
        </InputGroupButton>
        <Select
          value=""
          onValueChange={(value) => {
            if (value === "schedule") handleScheduleOpen()
            else if (value === "side-panel") withClear(onSendToSidePanel)
          }}
        >
          <SelectTrigger
            size="sm"
            className="rounded-l-none border-0 h-7 gap-0 px-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow"
            disabled={!text}
            aria-label="Mais opções"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            side="top"
            sideOffset={4}
            align="end"
            alignItemWithTrigger={false}
            className="min-w-44 p-1"
          >
            <SelectItem value="schedule">Agendar mensagem</SelectItem>
            <SelectItem value="side-panel">Enviar para chat lateral</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ScheduleMessageDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        onConfirm={handleScheduleConfirm}
      />
    </>
  )
}
