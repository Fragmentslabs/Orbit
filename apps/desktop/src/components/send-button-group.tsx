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

/** Input attachment at the moment of the click (url already in data URL, ready for the
 *  queue/schedule — blob URLs die when the input is cleared). */
export interface QueueAttachment {
  mediaType?: string;
  filename?: string;
  url?: string;
  /** Attachment that is a reference to the gallery (Media tab) — see FilePart.mediaId. */
  mediaId?: string;
  /** Attachment that is a conversation SOURCE (Sources tab) — see FilePart.sourceId. */
  sourceId?: string;
}

interface SendButtonGroupProps {
  busy: boolean;
  /** Cancellation phase: the abort was requested but the engine has not confirmed yet */
  cancelling?: boolean;
  onQueue: (text: string, files?: QueueAttachment[]) => void;
  onStopAndSend: (text: string, files?: QueueAttachment[]) => void;
  onSchedule: (text: string, timestamp: number, files?: QueueAttachment[]) => void;
  onSendToSidePanel: (text: string, files?: QueueAttachment[]) => void;
  onStop: () => void;
  disabled?: boolean;
  /**
   * Code mode without a folder: scheduling and sending to the side panel would record the
   * message without a directory, so the chevron menu does not open. Disabling only
   * that half is no use — Send and the chevron are a single visual piece, and
   * they would end up with two opacities. Here the click keeps responding: whoever
   * knows the reason shows the explanation.
   */
  onOptionsBlocked?: () => void;
  /**
   * In place of "Send" when there is nothing to send (empty field and no
   * attachment) and the agent is stopped (the call button). With `emptySlotAlways`
   * it stays in any case — in a call the slot is "hang up", which cannot
   * disappear because someone typed or the agent is answering.
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
  // Only one of the two Selects (queue or normal send) is mounted at a time, so
  // the open control is shared.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { textInput, attachments } = usePromptInputController();
  const text = textInput.value.trim();
  const hasText = text.length > 0;
  // An attachment is ALSO content. With large pasted text becoming a file (or a PDF
  // attached with no comment), the field stays EMPTY and the message still has something
  // to send: where one used to read "no text", one reads "no text and no attachment" —
  // otherwise Send is born disabled and the chip does not leave here.
  const hasAttachments = attachments.files.length > 0;
  const hasContent = hasText || hasAttachments;

  /**
   * Sends the input text + attachments. Converts blob URLs → data URLs BEFORE
   * clearing (text and chips): the clear revokes the blob URLs, and the queue/schedule
   * keep the message to send later — without the conversion the attachment becomes a
   * dead blob URL and the message leaves the queue without the file.
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
      // null = there is nothing pending; "" is a message with only an attachment.
      if (pendingText === null) return;
      onSchedule(pendingText, timestamp, pendingFiles ?? undefined);
      // The conversion already happened in open — safe to revoke the blob URLs now
      if (pendingFiles && pendingFiles.length > 0) attachments.clear();
      setPendingText(null);
      setPendingFiles(null);
      setScheduleOpen(false);
    },
    [pendingText, pendingFiles, onSchedule, attachments],
  );

  const handleOptionsOpenChange = useCallback(
    (next: boolean) => {
      // Blocked: it does not open (the menu only has actions that need the folder) and
      // gives the click back to whoever knows how to explain.
      if (next && onOptionsBlocked) {
        onOptionsBlocked();
        return;
      }
      setOptionsOpen(next);
    },
    [onOptionsBlocked],
  );

  // Nothing to send, with a button of its own for that case (the voice call).
  if (emptySlot && (emptySlotAlways || (!hasContent && !busy))) return <>{emptySlot}</>;

  // Only the stop button (nothing to send, agent running)
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

  // Agent running but with content in the input: "Add to queue" + dropdown
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

  // Normal state: "Send" button (type=submit for the form) + dropdown
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
