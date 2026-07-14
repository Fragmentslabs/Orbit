import { useState } from "react"
import { Download, Upload, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { dataApi } from "@/src/lib/ipc"

const LOCALSTORAGE_PREFIXES = ["orbit-", "theme", "sidebar", "panel-", "settings-", "preference"]

function collectLocalStorage(): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (LOCALSTORAGE_PREFIXES.some((p) => key.startsWith(p))) {
      const val = localStorage.getItem(key)
      if (val !== null) result[key] = val
    }
  }
  return result
}

export function DataPanel() {
  const [includeAuth, setIncludeAuth] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  const handleExport = async () => {
    setExporting(true)
    setMessage(null)
    try {
      const ls = collectLocalStorage()
      const result = await dataApi.export(includeAuth, ls)
      if (result.cancelled) return
      setMessage({ type: "success", text: `Dados exportados para: ${result.filePath}` })
    } catch (e) {
      setMessage({ type: "error", text: `Erro ao exportar: ${(e as Error).message}` })
    } finally {
      setExporting(false)
    }
  }

  const handleImport = async () => {
    if (!window.confirm("Importar dados substituirá seus dados atuais. Deseja continuar?")) return
    setImporting(true)
    setMessage(null)
    try {
      const result = await dataApi.import()
      if (result.cancelled) return
      if (result.error) {
        setMessage({ type: "error", text: result.error })
        return
      }
      if (result.localStorage && Object.keys(result.localStorage).length > 0) {
        for (const [k, v] of Object.entries(result.localStorage)) {
          localStorage.setItem(k, v)
        }
      }
      setMessage({ type: "success", text: "Dados importados com sucesso! Recarregando interface…" })
      setTimeout(() => window.location.reload(), 1500)
    } catch (e) {
      setMessage({ type: "error", text: `Erro ao importar: ${(e as Error).message}` })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">Exportar dados</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Baixe todos os seus dados (sessões, mensagens, memórias, skills, configurações) em um
          arquivo ZIP. Snapshots git e caches de modelo não são incluídos.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Chaves de API</span>
          <span className="text-xs text-muted-foreground">Incluir chaves salvas no backup</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={includeAuth}
          onClick={() => setIncludeAuth(!includeAuth)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            includeAuth ? "bg-primary" : "bg-input",
          )}
        >
          <span
            className={cn(
              "pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
              includeAuth ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>

      <Button disabled={exporting} onClick={() => void handleExport()} className="gap-2 self-start">
        {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        Exportar
      </Button>

      <div className="mt-4 border-t pt-4">
        <p className="text-sm font-semibold">Importar dados</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Selecione um arquivo ZIP exportado anteriormente para restaurar seus dados. Isso
          substituirá todos os dados atuais.
        </p>
      </div>

      <Button
        disabled={importing}
        onClick={() => void handleImport()}
        variant="secondary"
        className="gap-2 self-start"
      >
        {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Importar
      </Button>

      {message && (
        <div
          className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
            message.type === "success"
              ? "border-green-500/30 bg-green-500/10 text-green-600"
              : "border-red-500/30 bg-red-500/10 text-red-600"
          }`}
        >
          {message.type === "success" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          )}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  )
}
