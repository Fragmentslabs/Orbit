import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useLoopConfigStore } from "@/src/stores/loop-config-store"
import { RefreshCw } from "lucide-react"

export function LoopConfigDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const config = useLoopConfigStore((s) => s.config)
  const updateConfig = useLoopConfigStore((s) => s.updateConfig)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="size-4" />
            Configuração do Loop
          </DialogTitle>
          <DialogDescription>
            Limites para o modo loop: o agente revisa o próprio resultado e itera
            até completar a tarefa ou atingir o limite.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Iterações máximas</span>
            <Input
              type="number"
              min={1}
              max={10}
              value={config.maxIterations}
              onChange={(e) => updateConfig({ maxIterations: Math.max(1, Math.min(10, Number(e.target.value))) })}
            />
            <span className="text-[10px] text-muted-foreground">
              Quantas vezes o agente pode revisar e refinar o resultado (1-10)
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Tokens por revisão</span>
            <Input
              type="number"
              min={1000}
              max={20000}
              step={1000}
              value={config.maxTokensPerIter}
              onChange={(e) => updateConfig({ maxTokensPerIter: Math.max(1000, Math.min(20000, Number(e.target.value))) })}
            />
            <span className="text-[10px] text-muted-foreground">
              Limite de tokens para cada chamada de revisão (1.000-20.000)
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Timeout (minutos)</span>
            <Input
              type="number"
              min={1}
              max={60}
              value={config.timeoutMinutes}
              onChange={(e) => updateConfig({ timeoutMinutes: Math.max(1, Math.min(60, Number(e.target.value))) })}
            />
            <span className="text-[10px] text-muted-foreground">
              Tempo máximo total do loop antes de entregar resposta parcial (1-60)
            </span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={config.autoReview}
              onClick={() => updateConfig({ autoReview: !config.autoReview })}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${config.autoReview ? 'bg-primary' : 'bg-input'}`}
            >
              <span
                className={`pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-in-out ${config.autoReview ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
            <div className="flex flex-col">
              <span className="text-xs font-medium">Revisão automática</span>
              <span className="text-[10px] text-muted-foreground">
                Se desligado, pergunta antes de cada nova iteração
              </span>
            </div>
          </label>
        </div>
        <DialogFooter showCloseButton>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Concluir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
