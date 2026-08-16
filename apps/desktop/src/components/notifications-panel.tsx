import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Bell, MessageSquareIcon, TriangleAlert } from "lucide-react"
import { useNotificationPrefsStore } from "@/src/stores/notification-prefs-store"

function NotificationToggle({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: typeof Bell
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <Icon className="size-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-[11px] leading-tight text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
          checked ? "bg-primary" : "bg-input"
        }`}
      >
        <span
          className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  )
}

export function NotificationsPanel() {
  const { t } = useTranslation()
  const prefs = useNotificationPrefsStore((s) => s.prefs)
  const setPref = useNotificationPrefsStore((s) => s.setPref)
  const loadPrefs = useNotificationPrefsStore((s) => s.loadPrefs)

  useEffect(() => {
    void loadPrefs()
  }, [loadPrefs])

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("settings.tabs.notifications.label")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("settings.tabs.notifications.description")}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <NotificationToggle
          icon={Bell}
          title={t("preferences.notifications.pendingAskTitle")}
          description={t("preferences.notifications.pendingAskDescription")}
          checked={prefs.pendingAsk}
          onChange={(v) => void setPref("pendingAsk", v)}
        />
        <NotificationToggle
          icon={MessageSquareIcon}
          title={t("preferences.notifications.newMessageTitle")}
          description={t("preferences.notifications.newMessageDescription")}
          checked={prefs.newMessage}
          onChange={(v) => void setPref("newMessage", v)}
        />
        <NotificationToggle
          icon={TriangleAlert}
          title={t("preferences.notifications.chatErrorTitle")}
          description={t("preferences.notifications.chatErrorDescription")}
          checked={prefs.chatError}
          onChange={(v) => void setPref("chatError", v)}
        />
      </div>
    </div>
  )
}