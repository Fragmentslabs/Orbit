import { RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import type { PermissionMode, PermissionThresholds, RiskLevel, SensitivityLevel } from "@/shared/chat"

/**
 * Painel "Autonomia & Permissões" da SettingsDialog. Três cards de modo,
 * cada um com dois controles: terminalAuto (risco máximo auto) e decisionsAuto
 * (sensibilidade para decidir verbalmente — tool question). Defaults alinhados
 * à spec: ask=medium/medium, approve=high/medium, full=high/high.
 *
 * Piso de segurança (forbidden: escrita em .git/, rm -rf fora do projeto) é
 * hardcoded — não exposto na UI. Override só via config programática futura.
 */

const MODE_META: Record<PermissionMode, { title: string; tone: string; description: string }> = {
  ask: { title: "Modo Perguntar", tone: "text-amber-500", description: "Máxima colaboração. Confirma cada ação sensível e cada decisão importante." },
  approve: { title: "Modo Approve", tone: "text-sky-500", description: "Autonomia operacional: executa comandos de risco médio; pergunta nos altos risco e nas decisões estruturais." },
  full: { title: "Modo Full", tone: "text-destructive", description: "Máxima autonomia: executa e decide tudo dentro do piso absoluto de segurança (escrita em .git/, rm -rf fora do projeto) — sempre bloqueado." },
}

const TERMINAL_OPTIONS: { value: RiskLevel; label: string; hint: string }[] = [
  { value: "low", label: "Baixo", hint: "Pergunta para tudo que não for trivial (sem risco)" },
  { value: "medium", label: "Médio", hint: "Pergunta para risco médio (git push, .env) e alto (push --force, sudo)" },
  { value: "high", label: "Alto", hint: "Só pergunta para alto risco (sudo, rm -rf, push --force). Libera médio." },
]

const DECISIONS_OPTIONS: { value: SensitivityLevel; label: string; hint: string }[] = [
  { value: "low", label: "Baixa", hint: "Pergunta em toda decisão estrutural de produto/arquitetura" },
  { value: "medium", label: "Média", hint: "Decide escolhas básicas; pergunta decisões estruturais (DB, framework)" },
  { value: "high", label: "Alta", hint: "Decide tudo sozinho — nunca pergunta" },
]

function ModeCard({ mode }: { mode: PermissionMode }) {
  const thresholds = usePermissionPrefs((s) => s.thresholds[mode])
  const setThreshold = usePermissionPrefs((s) => s.setThreshold)
  const meta = MODE_META[mode]
  const t: PermissionThresholds = thresholds

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className={`text-sm font-semibold ${meta.tone}`}>{meta.title}</span>
      </div>
      <p className="mb-3 text-[11px] leading-tight text-muted-foreground">{meta.description}</p>

      <div className="flex flex-col gap-3">
        <div>
          <p className="mb-1 text-xs font-medium">Risco máximo no terminal (auto)</p>
          <SegmentedControl<RiskLevel>
            options={TERMINAL_OPTIONS}
            value={t.terminalAuto}
            onChange={(v) => setThreshold(mode, "terminalAuto", v)}
            className="w-full"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {TERMINAL_OPTIONS.find((o) => o.value === t.terminalAuto)?.hint}
          </p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">Sensibilidade para decisões estruturais</p>
          <SegmentedControl<SensitivityLevel>
            options={DECISIONS_OPTIONS}
            value={t.decisionsAuto}
            onChange={(v) => setThreshold(mode, "decisionsAuto", v)}
            className="w-full"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {DECISIONS_OPTIONS.find((o) => o.value === t.decisionsAuto)?.hint}
          </p>
        </div>
      </div>
    </div>
  )
}

export function AutonomyPanel() {
  const resetThresholds = usePermissionPrefs((s) => s.resetThresholds)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">Autonomia & Permissões</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Configure o nível de autonomia do agente para cada modo. Permissões controlam o que ele
          executa; decisões controlam quem escolhe a direção do projeto. O piso de segurança
          (escrita em <code>.git/</code>, <code>rm -rf</code> fora do projeto) é sempre bloqueado,
          independentemente dos modos.
        </p>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-3">
        <ModeCard mode="ask" />
        <ModeCard mode="approve" />
        <ModeCard mode="full" />
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground" onClick={resetThresholds}>
          <RotateCcwIcon className="size-3" />
          Restaurar padrões
        </Button>
      </div>
    </div>
  )
}
