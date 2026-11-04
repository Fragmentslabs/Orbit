import { RotateCcw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { SettingSelect } from "@/src/components/settings-row"
import { cn } from "@/lib/utils"
import type { MotionPropDef, PropFormValues } from "@/src/lib/motion-props-form"

/**
 * The form of a composition's props: one row per prop declared in props.json, the control chosen by the
 * type (text, number, colour, switch, select, image path). It only edits the RAW values; what is valid and what
 * goes to the preview and the render is decided by lib/motion-props-form.
 */
export function MotionPropsForm({
  schema,
  values,
  errors,
  onChange,
  onReset,
  changed,
}: {
  schema: Record<string, MotionPropDef>
  values: PropFormValues
  errors: Record<string, string>
  onChange: (name: string, value: string | boolean) => void
  onReset: () => void
  /** How many props differ from the defaults. */
  changed: number
}) {
  const { t } = useTranslation()
  const names = Object.keys(schema)

  /** "min:0" → "the value must be at least 0". */
  const errorText = (code: string) => {
    const [kind, n] = code.split(":")
    return t(`motion.propsError.${kind}`, { n })
  }

  return (
    <div className="rounded-md border bg-card/60 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("motion.propsTitle")}</p>
          <p className="text-[11px] leading-tight text-muted-foreground">{t("motion.propsHint")}</p>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" disabled={changed === 0} onClick={onReset}>
          <RotateCcw className="size-3" />
          {t("motion.propsReset")}
        </Button>
      </div>
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
        {names.map((name) => {
          const def = schema[name]
          const value = values[name]
          const error = errors[name]
          return (
            <div key={name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <label className="min-w-0 truncate text-xs font-medium" htmlFor={`prop-${name}`} title={name}>
                  {def.label ?? name}
                </label>
                {def.type === "boolean" ? (
                  <Switch id={`prop-${name}`} checked={Boolean(value)} onCheckedChange={(checked) => onChange(name, checked)} />
                ) : def.type === "select" ? (
                  <SettingSelect
                    value={String(value)}
                    onChange={(v) => onChange(name, v)}
                    options={(def.options ?? []).map((option) => ({ value: option, label: option }))}
                  />
                ) : def.type === "color" ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      aria-label={name}
                      // <input type=color> only takes #rrggbb: a 3 or 4 digit colour is shown as its 6 digit self
                      value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#000000"}
                      onChange={(e) => onChange(name, e.target.value)}
                      className="size-7 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5"
                    />
                    <Input id={`prop-${name}`} value={String(value)} onChange={(e) => onChange(name, e.target.value)} className="w-28 font-mono" aria-invalid={Boolean(error)} />
                  </div>
                ) : (
                  <Input
                    id={`prop-${name}`}
                    value={String(value)}
                    inputMode={def.type === "number" ? "decimal" : undefined}
                    onChange={(e) => onChange(name, e.target.value)}
                    className={cn("max-w-[14rem]", def.type === "image" && "font-mono")}
                    aria-invalid={Boolean(error)}
                    placeholder={def.type === "image" ? t("motion.propsImagePlaceholder") : undefined}
                  />
                )}
              </div>
              {error && <p className="text-right text-[11px] leading-tight text-destructive">{errorText(error)}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
