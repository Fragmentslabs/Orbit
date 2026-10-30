import { useTranslation } from "react-i18next"

/**
 * What the window shows when an error escapes all the other nets.
 *
 * Without this, what was left was the dark background of the window: it looked like the app
 * had frozen, and there was no way to know what broke. Here the error stays
 * visible — for whoever needs to report it — and reloading is one click.
 */
export function AppCrash({ error }: { error: Error }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-lg flex-col gap-3">
        <p className="text-sm font-medium">{t("appCrash.title")}</p>
        <p className="text-xs text-muted-foreground">{t("appCrash.hint")}</p>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ""}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="self-start rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {t("appCrash.reload")}
        </button>
      </div>
    </div>
  )
}
