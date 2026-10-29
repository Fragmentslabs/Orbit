import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListPlus, Send, Square } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InputGroupButton } from "@/components/ui/input-group";
import { usePromptInputController } from "@/src/components/ai/prompt-input";
import { ScheduleMessageDialog } from "@/src/components/schedule-message-dialog";
import { blobUrlsToDataUrls } from "@/src/lib/message-utils";
import { cn } from "@/lib/utils";

/** Anexo do input no momento do clique (url já em data URL, pronta para a
 *  fila/agendamento — blob URLs morrem quando o input é limpo). */
export interface QueueAttachment {
  mediaType?: string;
  filename?: string;
  url?: string;
  /** Anexo que é uma referência à galeria (aba Mídia) — ver FilePart.mediaId. */
  mediaId?: string;
  /** Anexo que é uma FONTE da conversa (aba Fontes) — ver FilePart.sourceId. */
  sourceId?: string;
}

interface SendButtonGroupProps {
  busy: boolean;
  /** Fase de cancelamento: o abort foi pedido mas o engine ainda não confirmou */
  cancelling?: boolean;
  onQueue: (text: string, files?: QueueAttachment[]) => void;
  onStopAndSend: (text: string, files?: QueueAttachment[]) => void;
  onSchedule: (text: string, timestamp: number, files?: QueueAttachment[]) => void;
  onSendToSidePanel: (text: string, files?: QueueAttachment[]) => void;
  onStop: () => void;
  disabled?: boolean;
  /**
   * Modo código sem pasta: agendar e enviar para o painel lateral gravariam a
   * mensagem sem diretório, então o menu do chevron não abre. Desabilitar só
   * essa metade não serve — o Enviar e o chevron são uma peça visual só, e
   * ficariam com duas opacidades. Aqui o clique continua respondendo: quem
   * sabe o motivo mostra a explicação.
   */
  onOptionsBlocked?: () => void;
  /**
   * No lugar do "Enviar" quando não há nada para enviar (campo vazio e nenhum
   * anexo) e o agente está parado (o botão de chamada). Com `emptySlotAlways`
   * ele fica em qualquer caso — em chamada o slot é o "desligar", que não pode
   * sumir porque alguém digitou ou o agente está respondendo.
   */
  emptySlot?: React.ReactNode;
  emptySlotAlways?: boolean;
}

export function SendButtonGroup({
  busy,
  cancelling,
  onQueue,
  onStopAndSend,
  onSchedule,
  onSendToSidePanel,
  onStop,
  disabled,
  onOptionsBlocked,
  emptySlot,
  emptySlotAlways,
}: SendButtonGroupProps) {
  const { t } = useTranslation();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<QueueAttachment[] | null>(null);
  // Só um dos dois Selects (fila ou envio normal) está montado por vez, então
  // o controle de abertura é compartilhado.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { textInput, attachments } = usePromptInputController();
  const text = textInput.value.trim();
  const hasText = text.length > 0;
  // Anexo TAMBÉM é conteúdo. Com texto grande colado virando arquivo (ou um PDF
  // anexado sem comentário), o campo fica VAZIO e a mensagem ainda tem o que
  // enviar: onde antes se lia "sem texto", lê-se "sem texto e sem anexo" —
  // senão o Enviar nasce desabilitado e o chip não sai daqui.
  const hasAttachments = attachments.files.length > 0;
  const hasContent = hasText || hasAttachments;

  /**
   * Envia o texto + anexos do input. Converte blob URLs → data URLs ANTES de
   * limpar (texto e chips): o clear revoga os blob URLs, e a fila/agendamento
   * guardam a mensagem para enviar depois — sem a conversão o anexo vira um
   * blob URL morto e a mensagem sai da fila sem o arquivo.
   */
  const withAttachments = useCallback(
    async (fn: (text: string, files?: QueueAttachment[]) => void) => {
      const current = textInput.value.trim();
      if (!current && attachments.files.length === 0) return;
      const files = await blobUrlsToDataUrls(attachments.files);
      fn(current, files.length > 0 ? files : undefined);
      textInput.clear();
      attachments.clear();
    },
    [textInput, attachments],
  );

  const handleScheduleOpen = useCallback(async () => {
    const current = textInput.value.trim();
    if (!current && attachments.files.length === 0) return;
    const files = await blobUrlsToDataUrls(attachments.files);
    setPendingFiles(files);
    setPendingText(current);
    textInput.clear();
    setScheduleOpen(true);
  }, [textInput, attachments]);

  const handleScheduleConfirm = useCallback(
    (timestamp: number) => {
      // null = não há nada pendente; "" é uma mensagem só de anexo.
      if (pendingText === null) return;
      onSchedule(pendingText, timestamp, pendingFiles ?? undefined);
      // A conversão já aconteceu no open — seguro revogar os blob URLs agora
      if (pendingFiles && pendingFiles.length > 0) attachments.clear();
      setPendingText(null);
      setPendingFiles(null);
      setScheduleOpen(false);
    },
    [pendingText, pendingFiles, onSchedule, attachments],
  );

  const handleOptionsOpenChange = useCallback(
    (next: boolean) => {
      // Bloqueado: não abre (o menu só tem ações que precisam da pasta) e
      // devolve o clique para quem sabe explicar.
      if (next && onOptionsBlocked) {
        onOptionsBlocked();
        return;
      }
      setOptionsOpen(next);
    },
    [onOptionsBlocked],
  );

  // Nada para enviar, com um botão próprio para esse caso (a chamada de voz).
  if (emptySlot && (emptySlotAlways || (!hasContent && !busy))) return <>{emptySlot}</>;

  // Apenas botão de parar (nada para enviar, agente rodando)
  if (busy && !hasContent) {
    return (
      <InputGroupButton
        aria-label={t("send.stop")}
        size="icon-sm"
        variant="default"
        type="button"
        disabled={cancelling}
        onClick={onStop}
        title={cancelling ? t("send.cancelling") : undefined}
      >
        <Square className={cn("size-4", cancelling && "animate-pulse")} />
      </InputGroupButton>
    );
  }

  // Agente rodando mas com conteúdo no input: "Adicionar à fila" + dropdown
  if (busy && hasContent) {
    return (
      <>
        <div className="flex items-center -space-x-px">
          <InputGroupButton
            aria-label={t("send.addToQueue")}
            size="sm"
            variant="default"
            type="button"
            className="rounded-r-none h-7 border border-primary"
            onClick={() => void withAttachments(onQueue)}
          >
            <ListPlus className="size-4 mr-1" />
            {t("send.addToQueue")}
          </InputGroupButton>
          <Select
            value=""
            open={optionsOpen}
            onOpenChange={handleOptionsOpenChange}
            onValueChange={(value) => {
              if (value === "side-panel") void withAttachments(onSendToSidePanel);
              else if (value === "stop-send") void withAttachments(onStopAndSend);
              else if (value === "schedule") void handleScheduleOpen();
            }}
          >
            <SelectTrigger
              size="default"
              className="rounded-l-none !h-7 gap-0 px-1.5 border-primary bg-primary text-primary-foreground hover:bg-primary/90 shadow dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
              aria-label={t("send.moreOptions")}
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
              <SelectItem value="side-panel">{t("send.openInSidePanel")}</SelectItem>
              <SelectItem value="stop-send">{t("send.stopAndSend")}</SelectItem>
              <SelectItem value="schedule">{t("send.schedule")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ScheduleMessageDialog
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          onConfirm={handleScheduleConfirm}
        />
      </>
    );
  }

  // Estado normal: botão "Enviar" (type=submit para o form) + dropdown
  return (
    <>
      <div className="flex items-center -space-x-px">
        <InputGroupButton
          aria-label={t("send.send")}
          size="sm"
          variant="default"
          type="submit"
          disabled={disabled || !hasContent}
          className="rounded-r-none h-7 border border-primary !transition-colors"
        >
          <Send className="size-4 mr-1" />
          {t("send.send")}
        </InputGroupButton>
        <Select
          value=""
          open={optionsOpen}
          onOpenChange={handleOptionsOpenChange}
          onValueChange={(value) => {
            if (value === "schedule") void handleScheduleOpen();
            else if (value === "side-panel") void withAttachments(onSendToSidePanel);
          }}
        >
          <SelectTrigger
            size="default"
            className="rounded-l-none !h-7 gap-0 px-1.5 border-primary bg-primary text-primary-foreground hover:bg-primary/90 shadow dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
            disabled={!hasContent}
            aria-label={t("send.moreOptions")}
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
            <SelectItem value="schedule">{t("send.scheduleMessage")}</SelectItem>
            <SelectItem value="side-panel">{t("send.sendToSidePanel")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ScheduleMessageDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        onConfirm={handleScheduleConfirm}
      />
    </>
  );
}
