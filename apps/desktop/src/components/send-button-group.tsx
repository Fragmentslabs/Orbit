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

interface SendButtonGroupProps {
  busy: boolean;
  onQueue: (text: string) => void;
  onStopAndSend: (text: string) => void;
  onSchedule: (text: string, timestamp: number) => void;
  onSendToSidePanel: (text: string) => void;
  onStop: () => void;
  disabled?: boolean;
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
  const { t } = useTranslation();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const textInput = usePromptInputController().textInput;
  const text = textInput.value.trim();
  const hasText = text.length > 0;

  const withClear = useCallback(
    (fn: (text: string) => void) => {
      const current = textInput.value.trim();
      if (!current) return;
      fn(current);
      textInput.clear();
    },
    [textInput],
  );

  const handleScheduleOpen = useCallback(() => {
    const current = textInput.value.trim();
    if (!current) return;
    setPendingText(current);
    textInput.clear();
    setScheduleOpen(true);
  }, [textInput]);

  const handleScheduleConfirm = useCallback(
    (timestamp: number) => {
      if (!pendingText) return;
      onSchedule(pendingText, timestamp);
      setPendingText(null);
      setScheduleOpen(false);
    },
    [pendingText, onSchedule],
  );

  // Apenas botão de parar (sem texto, agente rodando)
  if (busy && !hasText) {
    return (
      <InputGroupButton
        aria-label={t("send.stop")}
        size="icon-sm"
        variant="default"
        type="button"
        onClick={onStop}
      >
        <Square className="size-4" />
      </InputGroupButton>
    );
  }

  // Agente rodando mas com texto no input: "Adicionar à fila" + dropdown
  if (busy && hasText) {
    return (
      <>
        <div className="flex items-center -space-x-px">
          <InputGroupButton
            aria-label={t("send.addToQueue")}
            size="sm"
            variant="default"
            type="button"
            className="rounded-r-none h-7 border border-primary"
            onClick={() => withClear(onQueue)}
          >
            <ListPlus className="size-4 mr-1" />
            {t("send.addToQueue")}
          </InputGroupButton>
          <Select
            value=""
            onValueChange={(value) => {
              if (value === "side-panel") withClear(onSendToSidePanel);
              else if (value === "stop-send") withClear(onStopAndSend);
              else if (value === "schedule") handleScheduleOpen();
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
          disabled={disabled || !text}
          className="rounded-r-none h-7 border border-primary !transition-colors"
        >
          <Send className="size-4 mr-1" />
          {t("send.send")}
        </InputGroupButton>
        <Select
          value=""
          onValueChange={(value) => {
            if (value === "schedule") handleScheduleOpen();
            else if (value === "side-panel") withClear(onSendToSidePanel);
          }}
        >
          <SelectTrigger
            size="default"
            className="rounded-l-none !h-7 gap-0 px-1.5 border-primary bg-primary text-primary-foreground hover:bg-primary/90 shadow dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
            disabled={!text}
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
