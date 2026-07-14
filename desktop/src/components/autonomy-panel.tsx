import { RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import type { PermissionMode, PermissionThresholds, RiskLevel, SensitivityLevel } from "@shared/chat"

/** Painel "Autonomia & Permissões" da SettingsDialog. */

const MODE_META: Record<PermissionMode, { title: string; description: string }> = {
  ask: { title: "Modo Perguntar", description: "Máxima colaboração. Confirma cada ação sensível e cada decisão importante." },
  approve: { title: "Modo Approve", description: "Autonomia operacional: executa comandos de risco médio; pergunta nos altos risco e nas decisões estruturais." },
  full: { title: "Modo Full", description: "Máxima autonomia: executa e decide tudo dentro do piso absoluto de segurança (escrita em .git/, rm -rf fora do projeto) — sempre bloqueado." },
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

function ModeSection({ mode }: { mode: PermissionMode }) {
  const thresholds = usePermissionPrefs((s) => s.thresholds[mode])
  const setThreshold = usePermissionPrefs((s) => s.setThreshold)
  const meta = MODE_META[mode]
  const t: PermissionThresholds = thresholds

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-sm font-semibold">{meta.title}</span>
      </div>
      <p className="mb-3 text-[11px] leading-tight text-muted-foreground">{meta.description}</p>

      <div className="flex gap-4">
        <div className="flex-1">
          <p className="mb-1 text-xs font-medium">Risco máximo no terminal</p>
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
        <div className="flex-1">
          <p className="mb-1 text-xs font-medium">Sensibilidade para decisões</p>
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

      <div className="flex flex-col gap-6">
        <ModeSection mode="ask" />
        <ModeSection mode="approve" />
        <ModeSection mode="full" />
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
