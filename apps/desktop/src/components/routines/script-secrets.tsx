import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { KeyRoundIcon, Trash2Icon } from "lucide-react"
import { SECRET_NAME_PATTERN } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { routinesApi } from "@/src/lib/ipc"

/**
 * The secrets scripts can use by name (a read-only API token). The value is typed once and goes
 * straight to the keychain-backed store in the main process; this screen only ever sees names.
 */
export function ScriptSecrets({ wanted }: { wanted: readonly string[] }) {
  const { t } = useTranslation()
  const [names, setNames] = useState<string[]>([])
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => void routinesApi.listSecrets().then(setNames), [])
  useEffect(refresh, [refresh])

  const missing = wanted.filter((n) => !names.includes(n))
  const validName = SECRET_NAME_PATTERN.test(name)

  const save = async () => {
    const saved = await routinesApi.setSecret(name, value)
    if (!saved.ok) return setError(saved.error)
    setError(null)
    setName("")
    setValue("")
    refresh()
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRoundIcon className="size-3.5" />
        {t("routines.secrets.title")}
      </p>
      <p className="text-[11px] text-muted-foreground">{t("routines.secrets.hint")}</p>
      {missing.length > 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("routines.secrets.missing", { names: missing.join(", ") })}</p>
      )}
      {names.map((n) => (
        <div key={n} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono">{n}</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground"
            aria-label={t("routines.secrets.delete", { name: n })}
            onClick={() => void routinesApi.removeSecret(n).then(refresh)}
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
      ))}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder={t("routines.secrets.namePlaceholder")}
          className="h-7 w-44 font-mono text-xs"
          autoComplete="off"
        />
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("routines.secrets.valuePlaceholder")}
          className="h-7 min-w-40 flex-1 text-xs"
          autoComplete="off"
        />
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={!validName || value.trim() === ""}>
          {t("routines.secrets.save")}
        </Button>
      </form>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
